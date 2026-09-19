# syntax=docker/dockerfile:1

FROM node:24-alpine

# Keep this in sync with the spatie/browsershot constraint in composer.json:
# the container runs the control script shipped with that exact release.
ARG BROWSERSHOT_VERSION=5.4.0

ENV PUPPETEER_SKIP_DOWNLOAD=1 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    NODE_ENV=production \
    PORT=3000

# --disable-dev-shm-usage covers Docker's 64MB /dev/shm, which Chrome's renderer
# outgrows on heavy pages. --no-sandbox is not listed here on purpose: the
# server applies it itself, so overriding CHROME_ARGS cannot drop it.
ENV CHROME_ARGS="--disable-dev-shm-usage --disable-gpu"

RUN apk add --no-cache \
        chromium \
        ca-certificates \
        freetype \
        harfbuzz \
        nss \
        font-noto \
        font-noto-emoji \
        ttf-freefont \
        tini \
    && { [ -x /usr/bin/chromium-browser ] || ln -s /usr/bin/chromium /usr/bin/chromium-browser; }

WORKDIR /usr/src/app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

ADD --chmod=644 https://raw.githubusercontent.com/spatie/browsershot/${BROWSERSHOT_VERSION}/bin/browser.cjs ./browser.cjs

COPY app.js ./

RUN addgroup -S chrome && adduser -S -G chrome -h /home/chrome chrome \
    && chown -R chrome:chrome /usr/src/app
USER chrome

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "app.js"]
