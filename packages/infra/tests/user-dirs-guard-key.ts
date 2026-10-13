/** What `isolate-user-dirs.ts` leaves behind for `user-dirs-guard.ts`: the root, and the variables it set below it. */
export interface UserDirsIsolation {
  root: string;
  /** Every variable set, the home directory ones included. */
  vars: readonly string[];
  /** The subset that names the home directory itself. */
  homeVars: readonly string[];
}

export const USER_DIRS_ISOLATION = Symbol.for("argelanderspace.test.userDirsIsolation");
