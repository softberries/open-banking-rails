# ORACLE-ONLY initializer (copied into config/initializers by oracle.sh, removed on exit, never committed).
# Replaces the two external adapters with the repo's own in-memory fakes so the
# runtime oracle never calls Enable Banking or an LLM provider.
if ENV["ORACLE_FAKES"] == "1"
  Rails.application.config.after_initialize do
    Dir[Rails.root.join("spec/support/fakes/*.rb")].sort.each { |f| require f }
    fake_eb  = Fakes::EnableBankingClient.new
    fake_llm = Fakes::LlmClient.new
    begin
      user = User.order(:id).first
      seeder = Seeders::Showcase.new(user: user, fake_eb: fake_eb, fake_llm: fake_llm)
      seeder.send(:seed_random!)
      seeder.send(:configure_fake_eb_state, user.tpp_credentials.to_a)
      fake_eb.add_aspsp(name: "PKO BP", country: "PL")
      fake_eb.add_aspsp(name: "Revolut LT", country: "LT")
    rescue => e
      Rails.logger.warn("[oracle] fake EB state not configured: #{e.class}: #{e.message}")
    end
    EnableBanking::Client.define_singleton_method(:new) { |*_a, **_k| fake_eb }
    Llm::Client.define_singleton_method(:for) do |user:|
      raise Llm::Client::NotConfiguredError, "User has not configured an LLM provider - see /admin/settings/preferences" unless user.llm_setting&.configured?
      fake_llm
    end
    Rails.logger.info("[oracle] EnableBanking::Client and Llm::Client.for replaced by fakes")
  end
end
