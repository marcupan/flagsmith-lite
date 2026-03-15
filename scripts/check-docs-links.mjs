import {readdirSync, readFileSync, statSync} from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const docsRoots = ['README.md', 'docs'];
const markdownFiles = [];
const brokenLinks = [];

function walk(targetPath) {
    const absolutePath = path.resolve(rootDir, targetPath);

    if (!statSync(absolutePath).isDirectory()) {
        markdownFiles.push(absolutePath);
        return;
    }

    for (const entry of readdirSync(absolutePath)) {
        const nextPath = path.join(absolutePath, entry);
        const stats = statSync(nextPath);

        if (stats.isDirectory()) {
            walk(nextPath);
            continue;
        }

        if (nextPath.endsWith('.md')) {
            markdownFiles.push(nextPath);
        }
    }
}

for (const docsRoot of docsRoots) {
    try {
        walk(docsRoot);
    } catch {
        // Skip optional roots such as README.md before it exists.
    }
}

for (const file of markdownFiles) {
    const content = readFileSync(file, 'utf8');
    const links = [...content.matchAll(/\[[^\]]+]\(([^)]+)\)/g)];

    for (const [, rawTarget] of links) {
        const target = rawTarget.trim();

        if (
            !target ||
            target.startsWith('http://') ||
            target.startsWith('https://') ||
            target.startsWith('mailto:') ||
            target.startsWith('#')
        ) {
            continue;
        }

        const [targetPath] = target.split('#');
        const resolved = path.resolve(path.dirname(file), targetPath);

        try {
            statSync(resolved);
        } catch {
            brokenLinks.push({
                file: path.relative(rootDir, file),
                target,
            });
        }
    }
}

if (brokenLinks.length > 0) {
    console.error('Broken documentation links found:');

    for (const {file, target} of brokenLinks) {
        console.error(`- ${file} -> ${target}`);
    }

    process.exit(1);
}

console.log(`Docs links look valid (${markdownFiles.length} markdown files checked).`);
