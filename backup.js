const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const DIR = path.join(__dirname, 'web');
fs.mkdirSync(DIR, { recursive: true });

const TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY;

const TIMEOUT = 60000;

function shq(v) {
    return String(v == null ? '' : v).replace(/([\\`"$])/g, '\\$1');
}

function phpEsc(v) {
    return String(v == null ? '' : v).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function loadConfig() {
    const lines = fs.readFileSync(path.join(__dirname, 'web.txt'), 'utf8')
        .split(/\r?\n/)
        .map(s => s.trim())
        .filter(s => s && s[0] !== '#')
        .map(s => s.replace(/\s+#.*$/, '').trim())
        .filter(s => s);

    return lines.map(s => {
        const p = s.split('|').map(x => x.trim());
        const name = (p[0] || '').replace(/\/+$/, '');
        let dbHost = p[5] || '';
        let dbPort = '3306';
        if (dbHost.indexOf(':') > -1) {
            const parts = dbHost.split(':');
            dbHost = parts[0];
            dbPort = parts[1] || '3306';
        }
        return {
            name,
            url: 'http://' + name,
            host: p[1] || '',
            user: p[2] || '',
            pass: p[3] || '',
            remote: p[4] || '',
            db: {
                db_host: dbHost,
                db_port: dbPort,
                db_name: p[6] || '',
                db_user: p[7] || p[2] || '',
                db_pass: p[8] || p[3] || ''
            },
            hasDb: !!(p[5] && p[6])
        };
    }).filter(s => s.name && s.host);
}

function text(page) {
    return page.evaluate(() => document.body.innerText.trim());
}

async function passGate(page) {
    if ((await page.content()).includes('slowAES')) {
        await page.waitForNavigation({ waitUntil: 'networkidle', timeout: TIMEOUT });
        await page.waitForTimeout(1500);
    }
}

async function open(page, url) {
    await page.goto(url, { waitUntil: 'networkidle', timeout: TIMEOUT });
    await passGate(page);
    await page.waitForTimeout(1000);
    return text(page);
}

function renderBackup(s) {
    const tpl = fs.readFileSync(path.join(__dirname, 'backup.php'), 'utf8');
    const map = {
        __DB_HOST__: phpEsc(s.db.db_host),
        __DB_PORT__: String(parseInt(s.db.db_port, 10) || 3306),
        __DB_USER__: phpEsc(s.db.db_user),
        __DB_PASS__: phpEsc(s.db.db_pass),
        __DB_NAME__: phpEsc(s.db.db_name)
    };
    let out = tpl;
    Object.keys(map).forEach(k => { out = out.split(k).join(map[k]); });

    const dir = path.join(os.tmpdir(), `bkp-${s.name.replace(/[^a-z0-9_.-]/gi, '_')}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'backup.php'), out);
    return dir;
}

function runCmd(tag, cmd) {
    return new Promise((resolve, reject) => {
        const proc = spawn(cmd, { shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
        const log = d => {
            try {
                const out = d.toString().split('\n').filter(l => l).map(l => `  [${tag}] ${l}`).join('\n');
                if (out) process.stdout.write(out + '\n');
            } catch {}
        };
        proc.stdout.on('data', log);
        proc.stderr.on('data', log);
        proc.stdout.on('error', () => {});
        proc.stderr.on('error', () => {});
        proc.on('close', code => code === 0 ? resolve() : reject(Error(`exit ${code}`)));
        proc.on('error', reject);
    });
}

function lftp(s, cmd) {
    return runCmd(s.name, `lftp -c "set ftp:ssl-allow no; set ftp:passive-mode on; open -u ${shq(s.user)},${shq(s.pass)} ${shq(s.host)}; ${cmd}; bye"`);
}

async function ftpGet(s) {
    const d = path.join(DIR, s.name);
    fs.rmSync(d, { recursive: true, force: true });
    fs.mkdirSync(d, { recursive: true });
    await lftp(s, `mirror --parallel=6 --no-perms --no-umask --verbose ${shq(s.remote)} ${shq(d)}`);
}

async function ftpDel(s, rel) {
    await lftp(s, `rm ${shq(rel)}`);
}

async function ftpPut(s, localDir, remoteDir) {
    await lftp(s, `cd ${shq(remoteDir)}; put ${shq(path.join(localDir, 'backup.php'))}`);
}

async function do7z(s) {
    const d = path.join(DIR, s.name);
    const a = path.join(DIR, `${s.name}.7z`);
    if (!fs.existsSync(d) || fs.readdirSync(d).length === 0) {
        fs.rmSync(d, { recursive: true, force: true });
        return null;
    }
    await runCmd(s.name, `7z a -t7z -m0=lzma2 -mx=9 -mfb=273 -md=64m -ms=on "${a}" "${d}"/*`);
    if (!fs.existsSync(a) || fs.statSync(a).size <= 1000) {
        return null;
    }
    fs.rmSync(d, { recursive: true });
    return a;
}

function api(url, opts) {
    return new Promise((resolve, reject) => {
        const req = https.request(url, {
            method: opts.method || 'GET',
            headers: { 'Authorization': `Bearer ${TOKEN}`, 'User-Agent': 'node', 'Content-Type': 'application/json', ...opts.headers }
        }, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
        });
        req.on('error', reject);
        if (opts.body) req.write(opts.body);
        req.end();
    });
}

async function uploadAsset(file, releaseId) {
    if (!TOKEN || !REPO || !releaseId) return;
    const name = path.basename(file);

    const existing = await api(`https://api.github.com/repos/${REPO}/releases/${releaseId}/assets`, {});
    if (Array.isArray(existing)) {
        const old = existing.find(a => a.name === name);
        if (old) await api(`https://api.github.com/repos/${REPO}/releases/assets/${old.id}`, { method: 'DELETE' });
    }

    const url = `https://uploads.github.com/repos/${REPO}/releases/${releaseId}/assets?name=${name}`;
    const size = fs.statSync(file).size;
    await new Promise(resolve => {
        let settled = false;
        const done = () => { if (!settled) { settled = true; resolve(); } };
        const req = https.request(url, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/x-7z-compressed', 'Content-Length': size }
        }, res => {
            res.resume();
            if (res.statusCode >= 400) console.log(`  upload warn: HTTP ${res.statusCode} for ${name}`);
            done();
        });
        req.on('error', e => { console.log(`  upload error: ${e.message}`); done(); });
        req.on('socket', sock => sock.on('error', e => { console.log(`  upload socket error: ${e.message}`); done(); }));
        const stream = fs.createReadStream(file);
        stream.on('error', e => { console.log(`  upload read error: ${e.message}`); req.destroy(); done(); });
        stream.pipe(req);
    });
    if (fs.existsSync(file)) fs.unlinkSync(file);
}

async function ensureRelease() {
    if (!TOKEN || !REPO) return 0;
    const info = await api(`https://api.github.com/repos/${REPO}/releases/tags/backup`, {});
    if (info.id) return info.id;
    const created = await api(`https://api.github.com/repos/${REPO}/releases`, { method: 'POST', body: JSON.stringify({ tag_name: 'backup', name: 'backup' }) });
    return created.id || 0;
}

async function main() {
    const sites = loadConfig();
    console.log(`sites: ${sites.length} (with db: ${sites.filter(s => s.hasDb).length})\n`);

    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
    let ok = 0, done = 0, active = 0, maxMem = 0, maxConc = 3;
    const releaseId = await ensureRelease();

    async function run(s) {
        active++;
        const before = os.freemem();
        let tmp = null;
        let p = null;
        let deployed = false;
        let dumped = false;
        try {
            p = await browser.newPage({
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                viewport: { width: 1920, height: 1080 }
            });
            console.log(`[${s.name}] (active: ${active})`);

            if (s.hasDb) {
                process.stdout.write('  deploy... ');
                tmp = renderBackup(s);
                await ftpPut(s, tmp, s.remote);
                deployed = true;
                console.log('ok');

                process.stdout.write('  dump... ');
                const t = await open(p, `${s.url}/backup.php`);
                if (t.includes('404')) throw Error('backup.php not found (FTP 远程目录不对?)');
                if (/backup success/i.test(t)) {
                    dumped = true;
                    console.log(t);
                } else if (/error:/i.test(t)) {
                    throw Error(t);
                } else {
                    throw Error(`unexpected response: ${t.slice(0, 160)}`);
                }
            } else {
                console.log('  db: skip (web.txt 未填数据库)');
            }

            process.stdout.write('  ftp... ');
            await ftpGet(s);
            console.log('done');

            process.stdout.write('  compress... ');
            const a = await do7z(s);
            if (a) {
                console.log(`${(fs.statSync(a).size / 1048576).toFixed(2)} MB`);
                process.stdout.write('  upload... ');
                await uploadAsset(a, releaseId);
                console.log('ok');
            } else {
                console.log('no files');
            }

            ok++;
        } catch (e) {
            console.log(`  [${s.name}] fail: ${e.message}`);
        } finally {
            try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
            const quiet = dumped;
            await cleanup(s, `${s.remote}/backup.sql`, quiet);
            if (deployed) await cleanup(s, `${s.remote}/backup.php`, quiet);
            if (p) await p.close().catch(() => {});
            active--;
            profile(before);
        }
        done++;
        console.log(`progress: ${done}/${sites.length} (ok: ${ok})\n`);
    }

    async function cleanup(s, rel, quiet) {
        try {
            await ftpDel(s, rel);
        } catch (e) {
            if (!quiet) console.log(`  [${s.name}] cleanup ${rel} warn: ${e.message}`);
        }
    }

    function profile(before) {
        const used = (before - os.freemem()) / 1073741824;
        if (used > maxMem) {
            maxMem = used;
            maxConc = Math.max(1, Math.min(8, Math.floor(os.freemem() / 1073741824 / maxMem * 0.7)));
            console.log(`  profile: ${maxMem.toFixed(2)}GB/site, max concurrent: ${maxConc}`);
        }
    }

    for (const s of sites) {
        while (active >= maxConc) await new Promise(r => setTimeout(r, 3000));
        run(s).catch(e => console.log(`  [${s.name}] fatal: ${e.message}`));
    }

    while (active) await new Promise(r => setTimeout(r, 1000));
    await browser.close();
    console.log(`done: ${ok}/${sites.length}`);
}

process.stdout.on('error', e => { if (e.code !== 'EPIPE') throw e; });
process.stderr.on('error', e => { if (e.code !== 'EPIPE') throw e; });

main().catch(e => { console.error(e.message); process.exit(1); });
