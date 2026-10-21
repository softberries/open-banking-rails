# Run with: bin/rails runner /workspace/ruby-service-investigator/scripts/inventory.rb <outdir>
require "json"
out = ARGV[0] || "/tmp/inv"
Rails.application.eager_load!

def cb_info(model)
  %i[validation save create update destroy commit rollback initialize find touch].flat_map do |kind|
    chain = (model.send("_#{kind}_callbacks") rescue nil)
    next [] unless chain
    chain.map do |c|
      f = c.filter
      name = case f
             when Symbol, String then f.to_s
             when Proc then "proc@#{f.source_location&.join(':')&.sub(Rails.root.to_s + '/', '')}"
             else f.class.name
             end
      next nil if name.start_with?("ActiveModel::Validations", "ActiveRecord::Validations") # validators listed separately
      opts = {}
      opts[:if] = Array(c.instance_variable_get(:@if)).map { |x| x.is_a?(Proc) ? "proc" : x.to_s } rescue nil
      { kind: kind, phase: c.kind, filter: name, if: opts[:if] }
    end.compact
  end.compact
end

models = ActiveRecord::Base.descendants.reject(&:abstract_class?).sort_by(&:name).map do |m|
  next nil if m.name.nil?
  src = (Object.const_source_location(m.name)&.first rescue nil)
  {
    name: m.name,
    file: src&.sub(Rails.root.to_s + "/", ""),
    app_model: src.to_s.start_with?(Rails.root.join("app").to_s),
    table: (m.table_name rescue nil),
    table_exists: (m.table_exists? rescue false),
    primary_key: (m.primary_key rescue nil),
    sti: m.base_class != m ? m.base_class.name : nil,
    columns: (m.columns.map { |c| { name: c.name, type: c.sql_type, null: c.null, default: c.default } } rescue []),
    associations: m.reflect_on_all_associations.map { |a|
      { macro: a.macro, name: a.name, class_name: (a.class_name rescue nil), options: a.options.transform_values { |v| v.is_a?(Proc) ? "proc" : v.to_s } }
    },
    validations: m.validators.map { |v|
      { kind: v.kind, attributes: v.attributes, options: v.options.transform_values { |x| x.is_a?(Proc) ? "proc" : x.to_s } }
    },
    callbacks: cb_info(m),
    enums: (m.defined_enums rescue {}),
    scopes: (m.respond_to?(:scope_names) ? m.scope_names : []),
    encrypted_attributes: (m.encrypted_attributes.to_a rescue []),
    monetized: (m.respond_to?(:monetized_attributes) ? m.monetized_attributes : {}),
    has_paper_trail: m.respond_to?(:paper_trail_options) && m.paper_trail_options.present?,
    ransackable_attributes: (m.ransackable_attributes rescue nil),
    ransackable_associations: (m.ransackable_associations rescue nil)
  }
end.compact

# Collect scope names by parsing source (Rails doesn't keep a registry)
models.each do |h|
  next unless h[:file] && File.exist?(Rails.root.join(h[:file]))
  src = File.read(Rails.root.join(h[:file]))
  h[:scopes] = src.scan(/^\s*scope\s+:(\w+)/).flatten
  h[:class_methods_defined] = src.scan(/^\s*def\s+self\.(\w+[?!]?)/).flatten
  h[:constants] = src.scan(/^\s*([A-Z][A-Z0-9_]+)\s*=/).flatten
end
File.write(File.join(out, "models.json"), JSON.pretty_generate(models))

# Grape routes
grape = []
if defined?(Api)
  roots = [Api] + ObjectSpace.each_object(Class).select { |k| k < Grape::API::Instance rescue false }
  api = defined?(Api::Root) ? Api::Root : Api
  (api.routes rescue []).each do |r|
    grape << { method: r.request_method, path: r.path, version: r.version, description: r.description,
               params: r.params.transform_values { |v| v.is_a?(Hash) ? v.transform_values(&:to_s) : v.to_s },
               namespace: r.namespace, settings_auth: (r.settings[:auth] rescue nil) }
  end
end
File.write(File.join(out, "api_routes.json"), JSON.pretty_generate(grape))

# MCP tools
tools = []
if defined?(Mcp::ApplicationTool)
  ObjectSpace.each_object(Class).select { |k| k < Mcp::ApplicationTool }.sort_by(&:name).each do |t|
    tools << { class: t.name, name: (t.name_value rescue (t.tool_name rescue nil)), description: (t.description_value rescue (t.description rescue nil)).to_s,
               input_schema: (t.input_schema_value.to_h rescue (t.input_schema.to_h rescue nil)),
               file: (Object.const_source_location(t.name)&.first&.sub(Rails.root.to_s + "/", "") rescue nil) }
  end
end
File.write(File.join(out, "mcp_tools.json"), JSON.pretty_generate(tools))

# Jobs
jobs = ObjectSpace.each_object(Class).select { |k| (k < ActiveJob::Base rescue false) || (k.include?(Sidekiq::Job) rescue false) }
         .reject { |k| k.name.nil? || !Object.const_source_location(k.name)&.first.to_s.start_with?(Rails.root.to_s) }
         .sort_by(&:name).map { |k| { class: k.name, file: Object.const_source_location(k.name).first.sub(Rails.root.to_s + "/", ""),
                                       queue: (k.queue_name rescue nil).to_s, sidekiq_options: (k.get_sidekiq_options rescue nil) } }
File.write(File.join(out, "jobs.json"), JSON.pretty_generate(jobs))

# Mailers
mailers = ActionMailer::Base.descendants.map { |k| { class: k.name, actions: k.action_methods.to_a } }
File.write(File.join(out, "mailers.json"), JSON.pretty_generate(mailers))

# Rake tasks (app-defined only)
Rails.application.load_tasks
tasks = Rake::Task.tasks.select { |t| t.actions.any? { |a| a.source_location&.first.to_s.start_with?(Rails.root.join("lib").to_s) } }
          .map { |t| { name: t.name, comment: t.comment, file: t.actions.first.source_location.first.sub(Rails.root.to_s + "/", "") } }
File.write(File.join(out, "rake_tasks.json"), JSON.pretty_generate(tasks))
puts "models=#{models.size} app_models=#{models.count { _1[:app_model] }} api_routes=#{grape.size} mcp_tools=#{tools.size} jobs=#{jobs.size} mailers=#{mailers.size} tasks=#{tasks.size}"
