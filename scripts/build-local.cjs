const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

if (!fs.existsSync(path.join(process.cwd(), 'scripts', 'gen-version.ts'))) {
  if (fs.existsSync(path.join(process.cwd(), '..', 'scripts', 'gen-version.ts'))) {
    process.chdir(path.join(process.cwd(), '..'));
  }
}

execSync('bun scripts/gen-version.ts', { stdio: 'inherit' });
execSync('bun scripts/gen-migrations.ts', { stdio: 'inherit' });
execSync('bun run --filter @insight/web build', { stdio: 'inherit' });
