/**
 * The default answer to "is there a mail account?" for a Copilot host built without its own probe. Unset in
 * production (the host reads the real account store); the server tests install `() => false` so no test ever reads
 * the machine's real global data. Kept in its own file so installing it imports nothing else.
 */
export const mailAccountProbe: { default: (() => boolean) | undefined } = { default: undefined };
