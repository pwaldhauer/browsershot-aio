const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');

const express = require('express');

const port = Number(process.env.PORT || 3000);
const authToken = process.env.BROWSERSHOT_AIO_TOKEN || '';
const bodyLimit = process.env.BROWSERSHOT_AIO_BODY_LIMIT || '32mb';
const timeout = Number(process.env.BROWSERSHOT_AIO_TIMEOUT || 120) * 1000;

// Shipped with the Browsershot composer package and copied into the image at
// build time, so the container always speaks the exact protocol the PHP side
// generates. See the BROWSERSHOT_VERSION build argument in the Dockerfile.
const browserScript = process.env.BROWSERSHOT_SCRIPT || path.join(__dirname, 'browser.cjs');

const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || '';
// Chromium's sandbox does not work in this image, so --no-sandbox is applied
// here rather than left in CHROME_ARGS: overriding that variable to add a flag
// is normal, and doing so must not silently re-enable a sandbox that breaks
// every page load. Set CHROME_SANDBOX=1 to opt out.
const configuredArgs = (process.env.CHROME_ARGS || '').split(' ').filter(Boolean);
const defaultArgs = process.env.CHROME_SANDBOX === '1' || configuredArgs.includes('--no-sandbox')
    ? configuredArgs
    : ['--no-sandbox', ...configuredArgs];

// Beyond this the command no longer fits comfortably in argv, so hand it to
// browser.cjs as a file instead - the same fallback Browsershot itself uses.
const argvLimit = 96 * 1024;

const app = express();
app.use(express.json({ limit: bodyLimit }));

app.get('/health', async (request, response) => {
    response.json({
        status: 'ok',
        browserScript,
        executablePath,
        chromeArgs: defaultArgs,
        browser: await browserVersion(),
        // Puppeteer talks the protocol of the browser it pins. A browser that
        // is several majors away from this is worth suspecting when pages fail
        // in ways that make no sense.
        puppeteer: versionOf('puppeteer'),
        puppeteerExpectsBrowser: expectedBrowser(),
        // A tight container memory limit makes Chrome die on heavy pages in
        // ways that read as protocol errors.
        memory: memory(),
    });
});

app.post('/', (request, response) => {
    if (authToken && request.get('authorization') !== `Bearer ${authToken}`) {
        return response.status(401).json(failure(null, '', 'Invalid or missing authorization token.'));
    }

    const command = request.body;

    if (!command || typeof command !== 'object' || typeof command.action !== 'string') {
        return response.status(422).json(failure(null, '', 'Expected a Browsershot command object.'));
    }

    command.options = command.options || {};

    if (executablePath && !command.options.executablePath) {
        command.options.executablePath = executablePath;
    }

    if (defaultArgs.length) {
        command.options.args = [...defaultArgs, ...(command.options.args || [])];
    }

    const started = Date.now();

    runBrowserScript(command)
        .then(result => {
            log(command, started, result.exitCode, result.stderr);
            response.status(result.exitCode === 0 ? 200 : 500).json(result);
        })
        .catch(error => {
            log(command, started, null, error.message || String(error));
            response.status(500).json(failure(null, '', error.message || String(error)));
        });
});

app.listen(port, () => console.log(`Listening on port ${port}`));

let browserVersionPromise = null;

function browserVersion() {
    if (!browserVersionPromise) {
        browserVersionPromise = new Promise(resolve => {
            if (!executablePath) {
                return resolve(null);
            }
            execFile(executablePath, ['--version'], { timeout: 10000 }, (error, stdout) =>
                resolve(error ? null : stdout.trim()));
        });
    }
    return browserVersionPromise;
}

function readCgroup(file) {
    const bases = ['/sys/fs/cgroup', '/sys/fs/cgroup/memory'];

    // In a container with its own cgroup namespace the limit sits at the root.
    // Outside one it sits under the process's own cgroup path.
    try {
        const own = fs.readFileSync('/proc/self/cgroup', 'utf8').match(/^0::(.*)$/m);
        if (own && own[1] !== '/') {
            bases.unshift(path.join('/sys/fs/cgroup', own[1]));
        }
    } catch {
        // Not a cgroup v2 system; the defaults still apply.
    }

    for (const base of bases) {
        try {
            return fs.readFileSync(path.join(base, file), 'utf8').trim();
        } catch {
            // Try the next cgroup layout.
        }
    }
    return null;
}

function memory() {
    const limit = readCgroup('memory.max') ?? readCgroup('memory.limit_in_bytes');
    const usage = readCgroup('memory.current') ?? readCgroup('memory.usage_in_bytes');
    const mib = value => (value === null || value === 'max' || Number(value) > 2 ** 62 ? null : Math.round(Number(value) / 1048576));

    return { limitMiB: mib(limit), usageMiB: mib(usage) };
}

function versionOf(name) {
    try {
        return require(`${name}/package.json`).version;
    } catch {
        return null;
    }
}

function expectedBrowser() {
    try {
        return require('puppeteer-core/internal/revisions.js').PUPPETEER_REVISIONS.chrome;
    } catch {
        return null;
    }
}

function log(command, started, exitCode, stderr) {
    const outcome = exitCode === 0 ? 'ok' : `FAILED (exit ${exitCode})`;
    const detail = exitCode === 0 ? '' : ` - ${(stderr || 'no error output').split('\n')[0].slice(0, 200)}`;

    console.log(`${command.action} ${command.url} ${outcome} in ${Date.now() - started}ms${detail}`);
}

function failure(exitCode, stdout, stderr) {
    return { exitCode, stdout, stderr };
}

function runBrowserScript(command) {
    return new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        const payload = JSON.stringify(command);
        const optionsFile = payload.length > argvLimit
            ? path.join(os.tmpdir(), `browsershot-${id}.json`)
            : null;

        if (optionsFile) {
            fs.writeFileSync(optionsFile, payload);
        }

        // browser.cjs reports a failure with console.log(json) immediately
        // followed by process.exit(). Node does not flush a pipe before
        // exiting, so anything past the pipe buffer is lost - which is exactly
        // the diagnostics for the busy pages that tend to fail. Writes to a
        // file descriptor are synchronous, so collect the output that way.
        const stdoutFile = path.join(os.tmpdir(), `browsershot-${id}.out`);
        const stderrFile = path.join(os.tmpdir(), `browsershot-${id}.err`);
        const stdoutFd = fs.openSync(stdoutFile, 'w');
        const stderrFd = fs.openSync(stderrFile, 'w');
        const files = [optionsFile, stdoutFile, stderrFile];

        const collect = () => {
            for (const fd of [stdoutFd, stderrFd]) {
                try {
                    fs.closeSync(fd);
                } catch {
                    // Already closed.
                }
            }
            const read = file => {
                try {
                    return fs.readFileSync(file, 'utf8');
                } catch {
                    return '';
                }
            };
            return { stdout: read(stdoutFile), stderr: read(stderrFile) };
        };

        const child = spawn(process.execPath, [
            browserScript,
            optionsFile ? `-f file://${optionsFile}` : payload,
        ], { stdio: ['ignore', stdoutFd, stderrFd] });

        let timedOut = false;

        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, timeout);

        child.on('error', error => {
            clearTimeout(timer);
            collect();
            cleanup(files);
            reject(error);
        });

        child.on('close', (exitCode, signal) => {
            clearTimeout(timer);
            const { stdout, stderr } = collect();
            cleanup(files);

            if (timedOut) {
                return resolve(failure(exitCode, stdout, `Timed out after ${timeout / 1000}s.\n${stderr}`));
            }

            // A signal here means something killed the process rather than it
            // failing on its own. SIGKILL is usually the OOM killer.
            if (signal) {
                return resolve(failure(exitCode, stdout, `Killed by ${signal}${signal === 'SIGKILL' ? ' (out of memory?)' : ''}.\n${stderr}`));
            }

            resolve({ exitCode, stdout: stdout.trimEnd(), stderr });
        });
    });
}

function cleanup(files) {
    for (const file of files) {
        if (file) {
            fs.rm(file, { force: true }, () => {});
        }
    }
}
