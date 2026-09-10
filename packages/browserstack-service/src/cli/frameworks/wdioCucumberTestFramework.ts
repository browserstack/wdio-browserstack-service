import TestFramework from './testFramework.js'

/**
 * Routing target for `framework: 'cucumber'` on the CLI flow.
 *
 * Deliberately inert: the cucumber event model (scenario/step/hook state machine) is not
 * implemented, so this inherits `TestFramework`'s logging-only `trackEvent` and emits nothing.
 * It exists so the factory has an explicit cucumber branch instead of leaving `testFramework`
 * null, which silently drops every event with no error.
 */
export default class WdioCucumberTestFramework extends TestFramework {}
