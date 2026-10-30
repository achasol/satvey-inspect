import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { mkdirSync, openSync, writeFileSync, closeSync, readFileSync, unlinkSync } from 'node:fs';
import { freemem } from 'node:os';

const root = fileURLToPath(new URL('..', import.meta.url));
const ciProfile = process.env.SATVEY_TEST_PROFILE === 'ci';
const minimumFreeGiB = ciProfile ? 5 : 8;
const project = `satvey-test-${process.pid}-${Date.now()}`;
const base = [
  'compose',
  '--project-directory',
  root,
  '-p',
  project,
  '-f',
  resolve(root, 'infra/compose.test.yaml'),
  ...(ciProfile ? ['-f', resolve(root, 'infra/compose.test-ci.yaml')] : []),
];
const env = { ...process.env, COMPOSE_PROFILES: '', COMPOSE_PARALLEL_LIMIT: '1' };
const builder = 'satvey-verify-limited';
const lockPath = resolve(root, '.cache/verification.lock');
mkdirSync(resolve(root, '.cache'), { recursive: true });
function acquireLock() {
  try {
    const fd = openSync(lockPath, 'wx');
    writeFileSync(fd, JSON.stringify({ pid: process.pid, project }));
    closeSync(fd);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previousLock = JSON.parse(readFileSync(lockPath, 'utf8'));
    const previous = Number(previousLock.pid);
    if (!Number.isInteger(previous) || previous < 1)
      throw new Error('Invalid verification lock; inspect .cache/verification.lock');
    let alive = true;
    try {
      process.kill(previous, 0);
    } catch (e) {
      if (e.code === 'ESRCH') alive = false;
      else throw e;
    }
    if (alive)
      throw new Error(
        'A verification run is already active. Runs are serialized to protect CPU and RAM.',
      );
    if (!/^satvey-test-[0-9]+-[0-9]+$/.test(previousLock.project))
      throw new Error('Invalid previous verification project');
    const cleanup = spawnSync(
      'docker',
      [
        'compose',
        '--project-directory',
        root,
        '-p',
        previousLock.project,
        '-f',
        resolve(root, 'infra/compose.test.yaml'),
        'down',
        '--volumes',
        '--remove-orphans',
      ],
      { cwd: root, env, stdio: 'inherit', timeout: 60_000 },
    );
    if (cleanup.status !== 0)
      throw new Error('Previous verification cleanup failed; refusing to start another stack');
    unlinkSync(lockPath);
    acquireLock();
  }
}
function docker(args, check = true) {
  const result = spawnSync('docker', args, { cwd: root, env, stdio: 'inherit', timeout: 900_000 });
  if (check && result.status !== 0) throw new Error(`Docker verification step failed: ${args[0]}`);
  return result.status ?? 1;
}
function buildImages() {
  const useDaemonBuilder = process.env.SATVEY_TEST_USE_DAEMON_BUILDER === '1';
  if (!useDaemonBuilder) {
    const existing = spawnSync('docker', ['buildx', 'inspect', builder], {
      stdio: 'ignore',
      timeout: 30_000,
    });
    if (existing.status !== 0)
      docker([
        'buildx',
        'create',
        '--name',
        builder,
        '--driver',
        'docker-container',
        '--driver-opt',
        `memory=${ciProfile ? '2048m' : '4096m'}`,
        '--driver-opt',
        `memory-swap=${ciProfile ? '2048m' : '4096m'}`,
        '--driver-opt',
        'cpu-period=100000',
        '--driver-opt',
        `cpu-quota=${ciProfile ? '200000' : '400000'}`,
      ]);
    // Apply the selected budget when reusing a builder created with older limits.
    docker(['buildx', 'inspect', builder, '--bootstrap']);
    docker([
      'update',
      '--cpu-period',
      '100000',
      '--cpu-quota',
      ciProfile ? '200000' : '400000',
      '--memory',
      ciProfile ? '2g' : '4g',
      '--memory-swap',
      ciProfile ? '2g' : '4g',
      `buildx_buildkit_${builder}0`,
    ]);
  }
  const definitions = {
    api: ['apps/api/Dockerfile', 'apps/api'],
    go: ['apps/api/Dockerfile', 'apps/api', 'build'],
    'pdf-check': ['infra/pdf-check.Dockerfile', '.'],
    app: ['Dockerfile', '.', 'build'],
    browsers: ['infra/browser-tests.Dockerfile', '.'],
  };
  const targets =
    process.argv[2] === 'backend'
      ? ['api', 'go', 'pdf-check']
      : process.argv[2] === 'browser'
        ? ['api', 'app', 'browsers']
        : Object.keys(definitions);
  try {
    for (const target of targets) {
      const [file, context, stage] = definitions[target];
      // Docker 25's classic builder can reuse Desktop's already downloaded base
      // images. Its RUN containers receive the same hard CPU/RAM/swap budget.
      if (useDaemonBuilder) {
        const result = spawnSync(
          'docker',
          [
            'build',
            '--memory',
            ciProfile ? '2g' : '4g',
            '--memory-swap',
            ciProfile ? '2g' : '4g',
            '--cpu-period',
            '100000',
            '--cpu-quota',
            ciProfile ? '200000' : '400000',
            '--tag',
            `${project}-${target}`,
            '--file',
            file,
            ...(stage ? ['--target', stage] : []),
            context,
          ],
          { cwd: root, env: { ...env, DOCKER_BUILDKIT: '0' }, stdio: 'inherit', timeout: 900_000 },
        );
        if (result.status !== 0) throw new Error(`Cached-image build failed: ${target}`);
        continue;
      }
      docker([
        'buildx',
        'build',
        '--builder',
        builder,
        '--load',
        '--tag',
        `${project}-${target}`,
        '--file',
        file,
        ...(stage ? ['--target', stage] : []),
        context,
      ]);
    }
  } finally {
    if (!useDaemonBuilder) docker(['buildx', 'stop', builder], false);
  }
}

// Explicit environments in the test manifest never interpolate application secrets.
function run(args, { check = true, timeout = 900_000 } = {}) {
  const result = spawnSync('docker', [...base, ...args], {
    cwd: root,
    env,
    stdio: 'inherit',
    timeout,
  });
  if (check && result.status !== 0)
    throw new Error(
      `Isolated test command failed: ${args[0]} (${result.error?.message || result.status})`,
    );
  return result.status ?? 1;
}
mkdirSync(resolve(root, 'tests/artifacts'), { recursive: true });
if (freemem() < minimumFreeGiB * 1024 ** 3)
  throw new Error(
    `Verification needs at least ${minimumFreeGiB} GiB free RAM before starting. Close other work first.`,
  );
acquireLock();
let exitCode = 0;
try {
  buildImages();
  run(['up', '-d', '--wait', 'postgres', 'browser-postgres', 'rustfs', 'pdf', 'mail']);
  for (const bucket of ['satvey-test-go', 'satvey-test-browser'])
    run(['run', '--rm', '--no-deps', '-e', `S3_BUCKET=${bucket}`, 'api', 'storage-init']);
  if (process.argv[2] !== 'browser') {
    const goArgs = (process.env.TEST_GO_ARGS || '').split(/\s+/).filter(Boolean);
    run([
      'run',
      '--rm',
      'go',
      ...(goArgs.length ? ['go', 'test', '-p', '1', '-race', '-count=1', ...goArgs, './...'] : []),
    ]);
    if (!goArgs.length) {
      run(['run', '--rm', 'pdf-check']);
      run([
        'run',
        '--rm',
        '--entrypoint',
        'python',
        'pdf-check',
        '/check-annotations-pdf.py',
        '/artifacts/report-annotated.pdf',
      ]);
      run([
        'run',
        '--rm',
        '--entrypoint',
        'python',
        'pdf-check',
        '/check-format-pdf.py',
        '/artifacts/report-format.pdf',
      ]);
    } else
      console.log('Focused Go verification; full PDF validation requires the unfiltered suite.');
  }
  if (process.argv[2] !== 'backend') {
    // Its race/PDF checks are finished; reserve the budget for browser engines.
    run(['stop', 'postgres']);
    run(['run', '--rm', '--no-deps', 'api', 'migrate']);
    run([
      'run',
      '--rm',
      '--no-deps',
      '-e',
      'BOOTSTRAP_EMAIL=admin@satvey.local',
      '-e',
      'BOOTSTRAP_PASSWORD=local-inspection-2026',
      '-e',
      'BOOTSTRAP_ORG=satvey',
      'api',
      'bootstrap',
    ]);
    run(['up', '-d', '--wait', 'api', 'app']);
    run(
      [
        'run',
        '--rm',
        'browsers',
        'node',
        'tests/run.cjs',
        ...(process.env.TEST_BROWSER_ARGS || `--project=chromium --workers=${ciProfile ? 1 : 2}`)
          .split(/\s+/)
          .filter(Boolean),
      ],
      { timeout: 3_600_000 },
    );
  }
} catch (error) {
  console.error(error.message);
  exitCode = 1;
  run(['logs', '--tail', '80'], { check: false });
} finally {
  const artifactContainer = `${project}-export`;
  run(['run', '-d', '--name', artifactContainer, '--no-deps', 'artifacts'], { check: false });
  for (const [source, target] of [
    ['artifacts', 'tests/artifacts'],
    ['test-results', 'test-results'],
    ['playwright-report', 'playwright-report'],
  ]) {
    mkdirSync(resolve(root, target), { recursive: true });
    const exported = spawnSync(
      'docker',
      ['cp', `${artifactContainer}:/export/${source}/.`, resolve(root, target)],
      {
        cwd: root,
        stdio: 'inherit',
        timeout: 30_000,
      },
    );
    if (exported.status !== 0) exitCode = 1;
  }
  spawnSync('docker', ['rm', '-f', artifactContainer], { stdio: 'ignore', timeout: 30_000 });
  if (process.env.KEEP_TEST_STACK !== '1') {
    const cleaned = run(['down', '--volumes', '--remove-orphans'], { check: false }) === 0;
    if (cleaned) {
      try {
        unlinkSync(lockPath);
      } catch {}
    } else exitCode = 1;
  } else console.log(`Kept isolated project ${project}; the next run will clean it first.`);
}
process.exitCode = exitCode;
