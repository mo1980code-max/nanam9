# Nawras Arcade — one image, two run modes.
#
#   docker build -t nawras-arcade .        # runs every gate during the build
#   docker run --rm -p 8080:8080 nawras-arcade
#   docker run --rm nawras-arcade php bin/install.php   # zero-config sqlite install
#
# NOTE ON VERIFICATION: this file was written but not built — the sandbox that
# produced it has no docker daemon (`command -v docker` → nothing). Treat it as
# reviewed-by-reading, not as proven by `docker build`.

FROM php:8.3-cli-alpine AS gates

# pdo_sqlite for the zero-config install, pdo_mysql for production, mbstring for
# Arabic text, and python3 because the project's gates are written in Python
# (the reviewer cannot be assumed to have a PHP runtime, see tools/verify_php.py).
RUN apk add --no-cache python3 sqlite-libs icu-libs \
    && docker-php-ext-install pdo_mysql mbstring

WORKDIR /app
COPY composer.json package.json ./
COPY db db
COPY src src
COPY tools tools

# The build FAILS if any gate fails. This is deliberate: an image that cannot
# prove its schema dialects agree is not shippable.
RUN python3 tools/verify_php.py \
    && python3 tools/prove_runtime.py \
    && python3 tools/gen_schema_sql.py --verify \
    && python3 tools/gen_license_rules.py --verify


FROM php:8.3-cli-alpine

RUN apk add --no-cache sqlite-libs icu-libs \
    && docker-php-ext-install pdo_mysql mbstring \
    && addgroup -S arcade && adduser -S arcade -G arcade

WORKDIR /app
COPY --from=gates /app /app

# The site keeps its uploads and its sqlite database here; a volume mount
# survives a container rebuild.
RUN mkdir -p var/uploads var/db && chown -R arcade:arcade var

USER arcade
EXPOSE 8080
ENV PORT=8080 DB_DRIVER=sqlite

CMD ["php", "-S", "0.0.0.0:8080", "-t", "public"]
