# Browsershot All in One (everything here is still WIP)

This is a combinaton of two things:

- A Docker image based on [alpine-chrome](https://github.com/Zenika/alpine-chrome) including a simple Express server that executes the command generated by the [Browsershot library by Spatie](https://github.com/spatie/browsershot)
- A simple PHP wrapper that extends the original Browsershot library with the code to call the Express server instead of using node to call Puppeteer


## Why?

- I do not want to include Node and Puppeteer in my main PHP application image
- I do not want to mess with all the hassle of using `remoteInstance` 
- I do not want to use Lambda functions using the wonderful [sidecar-browsershot library](https://github.com/stefanzweifel/sidecar-browsershot) (Instead I was heavily influenced by it.)

## Caution

It may very well be that half of the functions of Browsershot do not work. I just tested simple pdf generation. Also the Express server has no authentication. I won't recommend using this in a production environment.


## Running

For more information please [see the README of alpine-chrome](https://github.com/Zenika/alpine-chrome)

```shell
docker container run -p 3000:3000 -it --rm --cap-add=SYS_ADMIN ghcr.io/pwaldhauer/browsershot-aio
```

Or use something like that in a docker-compose.yml:

```yaml
  chrome:
    image: ghcr.io/pwaldhauer/browsershot-aio
    restart: unless-stopped
    cap_add:
      - SYS_ADMIN
```

## Using in PHP

Use it like you would use `Browsershot` but replace it with `BrowsershotAio`. Be sure to set the url to the express server:

```php
use pwaio\BrowsershotAio\BrowsershotAio;

BrowsershotAio::setEndpoint('http://chrome:3000');

// if you do not want to create a shared volume for your containers
$data = BrowsershotAio::url('https://example.com')->base64Screenshot();

// an image will be saved (needs a shared volume)
BrowsershotAio::url('https://example.com')->save($pathToImage);

// a pdf will be saved (needs a shared volume)
BrowsershotAio::url('https://example.com')->save('example.pdf');
```




## License
MIT