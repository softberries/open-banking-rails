# bin/rails runner (RAILS_ENV=development) - builds oracle data. Output: fixture JSON path in ARGV[0]
require "json"
Dir[Rails.root.join("spec/support/fakes/*.rb")].sort.each { |f| require f }
out = ARGV[0]

def mk_user(email, name)
  u = User.find_or_initialize_by(email: email)
  u.name = name
  u.password = u.password_confirmation = "Password123!"
  u.save!
  u
end

def mk_token(user, name, raw, revoked: false)
  PersonalAccessToken.where(user: user, name: name).delete_all
  PersonalAccessToken.create!(user: user, name: name, token_digest: PersonalAccessToken.digest_for(raw),
                              last_four: raw[-4..], revoked_at: (revoked ? Time.current : nil))
end

main = mk_user("maciek@example.com", "John Doe")
main.update!(password: "Password123!", password_confirmation: "Password123!")
if main.bank_connections.none?
  r = Seeders::Showcase.call(user: main, fake_eb: Fakes::EnableBankingClient.new, fake_llm: Fakes::LlmClient.new)
  puts "showcase main: #{r.success?} #{r.error}"
end

other = mk_user("other@example.com", "Other Tenant")
if other.bank_connections.none?
  fe = Fakes::EnableBankingClient.new
  ds = fe.add_session(aspsp_name: "Dummy Bank", country: "PL")
  10.times { |i| fe.add_account(session_id: ds, uid: "dummy-#{i}") } # shift uid/session sequences so tenant 2 gets distinct uids
  20.times { fe.add_session(aspsp_name: "Dummy Bank", country: "PL") }
  r = Seeders::Showcase.call(user: other, fake_eb: fe, fake_llm: Fakes::LlmClient.new, seed: 42)
  puts "showcase other: #{r.success?} #{r.error}"
end

tok_main    = "obrl_oracle_main_token_000000000000000000000001"
tok_other   = "obrl_oracle_other_token_00000000000000000000002"
tok_revoked = "obrl_oracle_revoked_token_000000000000000000003"
mk_token(main, "oracle-main", tok_main)
mk_token(other, "oracle-other", tok_other)
mk_token(main, "oracle-revoked", tok_revoked, revoked: true)

def first_id(rel) = rel.order(:id).first&.id
fx = {
  users: { main: { id: main.id, email: main.email, password: "Password123!" }, other: { id: other.id, email: other.email, password: "Password123!" } },
  tokens: { main: tok_main, other: tok_other, revoked: tok_revoked },
  main: {
    bank_transaction_id: first_id(BankTransaction.where(bank_account_id: main.bank_accounts.select(:id))),
    cash_transaction_id: first_id(main.manual_transactions.where(linked_bank_transaction_id: nil)),
    category_id: first_id(main.categories), category_slug: main.categories.order(:id).first&.slug,
    leaf_category_slug: main.categories.where(kind: "expense").order(:path).last&.slug,
    merchant_id: first_id(main.merchants), merchant_slug: main.merchants.order(:id).first&.slug,
    merchant_rule_id: first_id(MerchantRule.where(user_id: main.id)),
    rule_merchant_id: MerchantRule.where(user_id: main.id).where.not(merchant_id: nil).order(:id).first&.merchant_id,
    tpp_credential_id: first_id(main.tpp_credentials),
    bank_connection_id: first_id(main.bank_connections),
    bank_account_id: first_id(main.bank_accounts),
    wallet_id: first_id(main.cash_wallets),
    operation_run_sync_id: first_id(OperationRun.where(triggered_by_user_id: main.id, kind: "transaction_sync")),
    operation_run_llm_id: first_id(OperationRun.where(triggered_by_user_id: main.id, kind: "llm_enrichment")),
    version_id: PaperTrail::Version.order(:id).first&.id
  },
  other: {
    bank_transaction_id: first_id(BankTransaction.where(bank_account_id: other.bank_accounts.select(:id))),
    category_id: first_id(other.categories), merchant_id: first_id(other.merchants),
    tpp_credential_id: first_id(other.tpp_credentials), bank_connection_id: first_id(other.bank_connections),
    cash_transaction_id: first_id(other.manual_transactions.where(linked_bank_transaction_id: nil))
  },
  counts: ActiveRecord::Base.connection.tables.sort.to_h { |t| [ t, ActiveRecord::Base.connection.select_value("select count(*) from #{t}").to_i ] }
}
File.write(out, JSON.pretty_generate(fx))
puts JSON.pretty_generate(fx.except(:counts)), fx[:counts].inspect
