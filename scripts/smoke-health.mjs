const url = process.argv[2] ?? process.env.SMOKE_URL ?? 'http://localhost:3000/health';

const response = await fetch(url, {
    headers: process.env.REQUEST_ID ? {'x-request-id': process.env.REQUEST_ID} : {},
});

if (!response.ok) {
    console.error(`Smoke check failed: ${response.status} ${response.statusText}`);

    process.exit(1);
}

const body = await response.json();
const requestId = response.headers.get('x-request-id');

if (
    body?.status !== 'ok' ||
    typeof body?.version !== 'string' ||
    typeof body?.timestamp !== 'string'
) {
    console.error('Smoke check failed: unexpected /health payload shape.');
    console.error(JSON.stringify(body, null, 2));

    process.exit(1);
}

console.log(`Health OK: ${url}`);
console.log(`version=${body.version}`);
console.log(`timestamp=${body.timestamp}`);
console.log(`x-request-id=${requestId ?? 'missing'}`);
