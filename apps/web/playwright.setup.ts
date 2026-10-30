export default async function globalSetup() {
  if (process.env.E2E_ISOLATED !== '1')
    throw new Error(
      'Use npm test or node scripts/test-stack.mjs; browser fixtures require an isolated test environment.',
    );
}
