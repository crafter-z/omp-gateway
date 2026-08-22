/**
 * Fixture "omp CLI" that fails fast: writes to stderr and exits non-zero
 * immediately. Daemon tests point cfg.omp.binary at this file so an allowed
 * inbound message reaches the runner and the run fails within milliseconds
 * (OmpRpcClient surfaces "exited before ready"), while a denied message
 * never spawns anything.
 */
console.error("fake-omp-fail: not a real agent");
process.exit(3);
