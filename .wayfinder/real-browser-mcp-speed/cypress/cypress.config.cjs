const fs = require('node:fs');

const outputPath = process.env.CYPRESS_BENCHMARK_OUTPUT;
let sampleStartedAt;

module.exports = {
  expose: {
    BENCHMARK_RUNS: 30,
  },
  e2e: {
    supportFile: false,
    specPattern: '**/*.cy.js',
    video: false,
    screenshotOnRunFailure: false,
    defaultCommandTimeout: 10_000,
    setupNodeEvents(on) {
      on('before:run', () => {
        if (outputPath) fs.writeFileSync(outputPath, 'iteration,elapsed_ms\n');
      });

      on('task', {
        'benchmark:start'() {
          sampleStartedAt = process.hrtime.bigint();
          return null;
        },
        'benchmark:stop'({ iteration }) {
          if (sampleStartedAt === undefined) throw new Error('Benchmark timer was not started');
          const elapsedMs = Number(process.hrtime.bigint() - sampleStartedAt) / 1_000_000;
          sampleStartedAt = undefined;
          if (outputPath) fs.appendFileSync(outputPath, `${iteration},${elapsedMs.toFixed(3)}\n`);
          return elapsedMs;
        },
      });
    },
  },
};
