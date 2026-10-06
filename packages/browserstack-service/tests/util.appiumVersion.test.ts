import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, it, beforeAll, afterAll } from 'vitest'

import { DEFAULT_APPIUM_3_VERSION } from '../src/constants.js'
import { getWdioMajorVersion, setDefaultAppiumVersion } from '../src/util.js'

describe('getWdioMajorVersion', () => {
    let tmpDir: string

    const fakeProject = (name: string, cliVersion?: string) => {
        const projectDir = path.join(tmpDir, name)
        fs.mkdirSync(projectDir, { recursive: true })
        if (cliVersion) {
            const cliDir = path.join(projectDir, 'node_modules', '@wdio', 'cli')
            fs.mkdirSync(path.join(cliDir, 'build'), { recursive: true })
            fs.writeFileSync(path.join(cliDir, 'package.json'), JSON.stringify({
                name: '@wdio/cli',
                version: cliVersion,
                exports: { '.': { require: './build/index.cjs' } }
            }))
            fs.writeFileSync(path.join(cliDir, 'build', 'index.cjs'), 'module.exports = {}')
        }
        return pathToFileURL(path.join(projectDir, 'wdio.conf.js')).href
    }

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wdio-major-'))
    })

    afterAll(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('reads the major version of the @wdio/cli that runs the tests', () => {
        expect(getWdioMajorVersion()).toBe(10)
    })

    it('reads a WebdriverIO 9 install', () => {
        expect(getWdioMajorVersion(fakeProject('v9', '9.32.0'))).toBe(9)
    })

    it('returns undefined when @wdio/cli is not installed', () => {
        expect(getWdioMajorVersion(fakeProject('none'))).toBeUndefined()
    })
})

describe('setDefaultAppiumVersion', () => {
    it('adds the default Appium 3 version to bstack:options', () => {
        const capability: WebdriverIO.Capabilities = { 'bstack:options': { deviceName: 'Pixel 8' } }

        expect(setDefaultAppiumVersion(capability)).toBe(true)
        expect(capability['bstack:options']).toEqual({ deviceName: 'Pixel 8', appiumVersion: DEFAULT_APPIUM_3_VERSION })
    })

    it('creates bstack:options when it is missing', () => {
        const capability: WebdriverIO.Capabilities = { 'appium:app': 'bs://app' }

        expect(setDefaultAppiumVersion(capability)).toBe(true)
        expect(capability['bstack:options']).toEqual({ appiumVersion: DEFAULT_APPIUM_3_VERSION })
    })

    it('uses the legacy key for legacy capabilities, which WebdriverIO rejects next to bstack:options', () => {
        const capability = { app: 'bs://app', device: 'Google Pixel 8', 'browserstack.local': true } as WebdriverIO.Capabilities

        expect(setDefaultAppiumVersion(capability)).toBe(true)
        expect(capability['bstack:options']).toBeUndefined()
        expect((capability as Record<string, unknown>)['browserstack.appium_version']).toBe(DEFAULT_APPIUM_3_VERSION)
    })

    it('keeps an appiumVersion that the user set', () => {
        const capability: WebdriverIO.Capabilities = { 'bstack:options': { appiumVersion: '3.5.2' } }

        expect(setDefaultAppiumVersion(capability)).toBe(false)
        expect(capability['bstack:options']?.appiumVersion).toBe('3.5.2')
    })

    it('keeps a legacy browserstack.appium_version that the user set', () => {
        const capability = { 'browserstack.appium_version': '2.0.1' } as WebdriverIO.Capabilities

        expect(setDefaultAppiumVersion(capability)).toBe(false)
        expect(capability['bstack:options']).toBeUndefined()
    })
})
