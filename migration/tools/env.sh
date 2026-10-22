export BUNDLE_PATH=/workspace/ruby-service-investigator/bundle
export MISE_RUBY_VERSION=3.4.8
export PATH=/opt/mise/installs/ruby/3.4.8/bin:$PATH
export OTEL_SDK_DISABLED=true
export POSTGRES_HOST=127.0.0.1 POSTGRES_PORT=5432 POSTGRES_USER=postgres POSTGRES_PASSWORD=postgres
export REDIS_URL=redis://127.0.0.1:6379/0
export RAILS_ENV=${RAILS_ENV:-test}
export ACTIVE_RECORD_ENCRYPTION_PRIMARY_KEY=$(openssl rand -hex 32)
export ACTIVE_RECORD_ENCRYPTION_DETERMINISTIC_KEY=$(openssl rand -hex 32)
export ACTIVE_RECORD_ENCRYPTION_KEY_DERIVATION_SALT=$(openssl rand -hex 32)
export TMPDIR=/workspace/ruby-service-investigator/tmp GEM_HOME=/workspace/ruby-service-investigator/gems XDG_CACHE_HOME=/workspace/ruby-service-investigator/.cache GRADLE_USER_HOME=/workspace/ruby-service-investigator/.gradle
export PATH=$GEM_HOME/bin:$PATH
