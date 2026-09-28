# syntax=docker/dockerfile:1.7
# One image for the control API, the job worker, migrations and the fixture
# application. It runs TypeScript from source with tsx (no build step) on the
# pinned Playwright base, whose Chromium matches @playwright/test 1.56.1.
FROM mcr.microsoft.com/playwright:v1.56.1-noble

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    QA_SUITE_BASE_DIR=/app \
    npm_config_update_notifier=false \
    npm_config_fund=false

WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/cli/package.json apps/cli/
COPY apps/worker/package.json apps/worker/
COPY fixtures/test-app/package.json fixtures/test-app/
COPY packages packages
# Optional build secret `npm_ca`: extra CA bundle for TLS-intercepting proxies.
RUN --mount=type=secret,id=npm_ca,required=false \
    if [ -f /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca npm_config_cafile=/run/secrets/npm_ca; fi; \
    npm ci --include=dev --no-audit
COPY . .

# Drop root: the worker drives a browser against untrusted applications.
RUN mkdir -p /var/qa/runs /var/qa/artifacts && chown -R pwuser:pwuser /var/qa
USER pwuser

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(process.env.QA_ROLE==='api'?1:0))"
ENTRYPOINT ["npx", "--no-install", "tsx", "apps/cli/src/main.ts"]
CMD ["serve-api"]
