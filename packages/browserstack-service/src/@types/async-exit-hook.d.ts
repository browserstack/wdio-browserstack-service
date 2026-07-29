declare module 'async-exit-hook' {
    type ExitHookCallback = (done: () => void) => void
    interface ExitHook {
        (hook: ExitHookCallback): void
        forceExitTimeout(ms: number): void
        uncaughtExceptionHandler(hook: (err: Error, done?: () => void) => void): void
        unhandledRejectionHandler(hook: (err: Error, done?: () => void) => void): void
        hookEvent(event: string, code?: number, filter?: (...args: unknown[]) => boolean): void
        unhookEvent(event: string): void
        hookedEvents(): string[]
    }
    const exitHook: ExitHook
    export default exitHook
}
