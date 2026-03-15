import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

const checks = [
    {
        name: 'Root package.json',
        ok: existsSync('package.json'),
        level: 'critical',
        detail: 'Required for workspace scripts and dependency graph.',
    },
    {
        name: 'Docker Compose file',
        ok: existsSync('docker-compose.yml'),
        level: 'critical',
        detail: 'Describes local infra parity for `db`, `cache`, `api`, `web`.',
    },
    {
        name: 'API env example',
        ok: existsSync('apps/api/.env.example'),
        level: 'critical',
        detail: 'Provides a minimal list of env vars for the API.',
    },
    {
        name: 'Web env example',
        ok: existsSync('apps/web/.env.example'),
        level: 'critical',
        detail: 'Provides a minimal list of env vars for the web.',
    },
    {
        name: 'CI workflow',
        ok: existsSync('.github/workflows/ci.yml'),
        level: 'critical',
        detail: 'Must exist as versioned automation, not a local file.',
    },
    {
        name: 'Staff playbook',
        ok: existsSync('docs/staff-playbook'),
        level: 'critical',
        detail: 'Contains educational and operational documentation layers.',
    },
];

const versions = [
    ['node', ['--version']],
    ['pnpm', ['--version']],
    ['docker', ['--version']],
];

for (const [command, args] of versions) {
    const result = spawnSync(command, args, {encoding: 'utf8'});

    checks.push({
        name: `${command} available`,
        ok: result.status === 0,
        level: command === 'docker' ? 'warning' : 'critical',
        detail:
            result.status === 0
                ? result.stdout.trim()
                : `Command \`${command}\` is not available in PATH.`,
    });
}

const dockerInfo = spawnSync('docker', ['info'], {encoding: 'utf8'});
checks.push({
    name: 'Docker daemon reachable',
    ok: dockerInfo.status === 0,
    level: 'warning',
    detail:
        dockerInfo.status === 0
            ? 'Docker daemon is responding.'
            : 'Docker CLI is present, but daemon is unreachable. `docker compose up` will fail.',
});

let hasCriticalFailure = false;

for (const check of checks) {
    const marker = check.ok ? 'PASS' : check.level === 'critical' ? 'FAIL' : 'WARN';

    console.log(`${marker}  ${check.name}`);
    console.log(`      ${check.detail}`);

    if (!check.ok && check.level === 'critical') {
        hasCriticalFailure = true;
    }
}

if (hasCriticalFailure) {
    process.exit(1);
}
