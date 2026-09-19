<?php

namespace pwaio\BrowsershotAio;

use Spatie\Browsershot\Browsershot;
use Spatie\Browsershot\ChromiumResult;
use Spatie\Browsershot\Exceptions\CouldNotTakeBrowsershot;
use Spatie\Browsershot\Exceptions\ElementNotFound;
use Spatie\Browsershot\Exceptions\RemoteConnectionException;
use Spatie\Browsershot\Exceptions\UnsuccessfulResponse;

/**
 * Browsershot that hands its command to the browsershot-aio container over HTTP
 * instead of running node and puppeteer next to the PHP process.
 */
class BrowsershotAio extends Browsershot
{
    protected static string $defaultEndpoint = 'http://localhost:3000';

    protected static ?string $defaultToken = null;

    protected ?string $endpoint = null;

    protected ?string $token = null;

    public static function setEndpoint(string $endpoint): void
    {
        static::$defaultEndpoint = rtrim($endpoint, '/');
    }

    public static function setToken(?string $token): void
    {
        static::$defaultToken = $token;
    }

    public function usingEndpoint(string $endpoint): static
    {
        $this->endpoint = rtrim($endpoint, '/');

        return $this;
    }

    public function usingToken(?string $token): static
    {
        $this->token = $token;

        return $this;
    }

    public function getEndpoint(): string
    {
        return $this->endpoint ?? static::$defaultEndpoint;
    }

    protected function callBrowser(array $command): string
    {
        $this->chromiumResult = null;

        // The container cannot see our filesystem, so ask it for the bytes and
        // write the target file here. Callers such as save() only check that the
        // file exists afterwards, so they are none the wiser.
        $targetPath = $command['options']['path'] ?? null;
        unset($command['options']['path']);

        [$status, $body, $transportError] = $this->sendCommand($command);

        if ($transportError !== null) {
            throw new CouldNotTakeBrowsershot("Could not reach the browsershot-aio endpoint {$this->getEndpoint()}: {$transportError}");
        }

        $response = json_decode($body, true);

        if (! is_array($response)) {
            throw new CouldNotTakeBrowsershot("The browsershot-aio endpoint returned an unexpected response (HTTP {$status}): ".mb_substr($body, 0, 500));
        }

        $exitCode = $response['exitCode'] ?? null;
        $stderr = rtrim((string) ($response['stderr'] ?? ''));

        $stdout = (string) ($response['stdout'] ?? '');
        $decoded = json_decode($stdout, true);

        // Empty is normal for a transport-level failure. Non-empty but
        // unparseable means the output was cut off on its way here, and the
        // diagnostics would otherwise just look absent.
        $truncated = $stdout !== '' && ! is_array($decoded)
            ? ' [the container returned '.strlen($stdout).' bytes of unparseable output]'
            : '';

        $this->chromiumResult = new ChromiumResult(is_array($decoded) ? $decoded : null);

        if ($exitCode === 0) {
            $result = $this->chromiumResult->getResult();

            if ($targetPath !== null) {
                file_put_contents($targetPath, base64_decode($result));

                return '';
            }

            return $result;
        }

        throw match ($exitCode) {
            4 => RemoteConnectionException::make($stderr),
            3 => UnsuccessfulResponse::make($this->url, $stderr),
            2 => ElementNotFound::make($command['options']['selector'] ?? ''),
            default => new CouldNotTakeBrowsershot('browsershot-aio failed with exit code '.var_export($exitCode, true).': '.($stderr ?: $this->chromiumResult->getException() ?? 'no error output').$truncated),
        };
    }

    /**
     * @return array{0: int, 1: string, 2: string|null} status, body, transport error
     */
    protected function sendCommand(array $command): array
    {
        $headers = ['Content-Type: application/json'];

        if ($token = $this->token ?? static::$defaultToken) {
            $headers[] = 'Authorization: Bearer '.$token;
        }

        $handle = curl_init($this->getEndpoint());
        curl_setopt_array($handle, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => json_encode($command),
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 10,
            // The container enforces its own timeout, give it room to report back.
            CURLOPT_TIMEOUT => $this->timeout + 10,
        ]);

        $body = curl_exec($handle);
        $error = curl_errno($handle) ? curl_error($handle) : null;
        $status = (int) curl_getinfo($handle, CURLINFO_HTTP_CODE);
        curl_close($handle);

        return [$status, is_string($body) ? $body : '', $error];
    }
}
