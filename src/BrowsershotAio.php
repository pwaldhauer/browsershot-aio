<?php

namespace pwaio\BrowsershotAio;

use Illuminate\Support\Arr;
use Illuminate\Support\Facades\Http;
use Spatie\Browsershot\Browsershot;
use Spatie\Browsershot\Exceptions\CouldNotTakeBrowsershot;

class BrowsershotAio extends Browsershot
{

    static $endpointUrl = 'http://localhost:3000';

    static public function setEndpoint(string $endpointUrl) {
        self::$endpointUrl = $endpointUrl;
    }

    protected function callBrowser(array $command): string
    {
        $response = Http::post(self::$endpointUrl, $command);

        if ($response->status() != 200) {
            throw new CouldNotTakeBrowsershot($response->body());
        }

        $path = Arr::get($command, 'options.path');

        if ($path) {
            file_put_contents($path, base64_decode($response->body()));

            return $path;
        } 
        
        return $response->body();
    }

}
