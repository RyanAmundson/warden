export const requireNode25 = (version: string): void => {
  if (Number(version.split(".")[0]) < 25) {
    throw new Error(`Warden needs Node 25 or newer; this is Node ${version}. Next action: install Node 25 or newer, then run warden again`);
  }
};
