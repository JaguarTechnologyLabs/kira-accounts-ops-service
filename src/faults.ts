// Chaos hooks used by the sandbox to simulate infrastructure failures.
// (Real deployments set these via env; here the seed toggles them.)
export const faults: { crashMidRequestFor?: string } = {};
