# Browsershot All in One

Two things that belong together:

- A Docker image with Chromium, Node and a small Express server that runs the puppeteer
  script shipped with the [Browsershot library by Spatie](https://github.com/spatie/browsershot)
- A PHP wrapper that extends Browsershot so it posts its command to that server instead
  of shelling out to node locally

## Why?

- I do not want to include Node and Puppeteer in my main PHP application image
- I do not want to mess with all the hassle of using `remoteInstance`
- I do not want to use Lambda functions using the wonderful [sidecar-browsershot library](https://github.com/stefanzweifel/sidecar-browsershot) (Instead I was heavily influenced by it.)

## How it works

The container does not reimplement puppeteer control. At build time it downloads
`bin/browser.cjs` from the Browsershot release it is pinned to, and the Express server
spawns that script per request with the command JSON the PHP side generated — exactly
like Browsershot would locally. Nothing to keep in sync by hand, and every Browsershot
option behaves the same as it does upstream.

The server answers with the script's exit code, stdout and stderr, which the PHP wrapper
turns back into the regular Browsershot return values and exceptions.

### Keeping it current

`BROWSERSHOT_VERSION` in the `Dockerfile` and the `spatie/browsershot` constraint in
`composer.json` describe the same release. Bump them together.

## Running

```shell
docker container run -p 3000:3000 -it --rm ghcr.io/pwaldhauer/browsershot-aio
```

Or in a `docker-compose.yml`:

```yaml
services:
  chrome:
    image: ghcr.io/pwaldhauer/browsershot-aio
    restart: unless-stopped
    shm_size: 1gb
    environment:
      BROWSERSHOT_AIO_TOKEN: ${BROWSERSHOT_TOKEN}
```

### Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | Port the server listens on |
| `BROWSERSHOT_AIO_TOKEN` | *(empty)* | When set, requests must send `Authorization: Bearer <token>` |
| `CHROME_ARGS` | `--disable-dev-shm-usage --disable-gpu` | Space separated Chromium flags prepended to every request. Safe to override; `--no-sandbox` is added separately and is not lost |
| `CHROME_SANDBOX` | *(unset)* | Set to `1` to keep Chromium's sandbox. Every page load fails if you do |
| `BROWSERSHOT_AIO_TIMEOUT` | `120` | Seconds before a browser run is killed |
| `BROWSERSHOT_AIO_BODY_LIMIT` | `32mb` | Maximum request body size |
| `PUPPETEER_EXECUTABLE_PATH` | `/usr/bin/chromium-browser` | Chromium binary used when the command does not name one |

`GET /health` reports the server status, the control script, the browser in use and its version, the Chrome build puppeteer expects, and the default Chromium flags.

## Using in PHP

```shell
composer require pwaio/browsershot-aio
```

Use it like you would use `Browsershot`, but point it at the server:

```php
use pwaio\BrowsershotAio\BrowsershotAio;

BrowsershotAio::setEndpoint('http://chrome:3000');
BrowsershotAio::setToken($token); // only if the container requires one

$html = BrowsershotAio::url('https://example.com')->bodyHtml();

$data = BrowsershotAio::url('https://example.com')->base64Screenshot();

// Saving works without a shared volume: the bytes come back over HTTP and are
// written here.
BrowsershotAio::url('https://example.com')->save($pathToImage);
BrowsershotAio::url('https://example.com')->savePdf('example.pdf');
```

Endpoint and token can also be set per instance, which is handy when the defaults come
from config:

```php
BrowsershotAio::url($url)->usingEndpoint($endpoint)->usingToken($token)->base64Screenshot();
```

### Caveats

- `Browsershot::html()` and anything else that feeds Chromium a local `file://` path needs a volume shared between both containers — the browser cannot read your application's filesystem otherwise. Rendering by URL is unaffected.
- The server runs whatever browser command it is given. Keep it on an internal network,
  and set `BROWSERSHOT_AIO_TOKEN` if anything else can reach it.

## License


MIT
