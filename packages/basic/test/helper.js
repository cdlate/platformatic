import { createDirectory, withResolvers } from '@platformatic/utils'
import { deepStrictEqual, ok, strictEqual } from 'node:assert'
import { existsSync } from 'node:fs'
import { readFile, symlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Client, request } from 'undici'
import WebSocket from 'ws'
import { loadConfig } from '../../config/index.js'
import { buildServer, platformaticRuntime } from '../../runtime/index.js'

export { setTimeout as sleep } from 'node:timers/promises'

const HMR_TIMEOUT = process.env.CI ? 20000 : 10000
let hrmVersion = Date.now()
export let fixturesDir

export function setFixturesDir (directory) {
  fixturesDir = directory
}

// This is used to debug tests
export function pause (url, timeout = 300000) {
  console.log(`Server is listening at ${url}`)
  return sleep(timeout)
}

export async function ensureDependency (directory, pkg, source) {
  const [namespace, name] = pkg.includes('/') ? pkg.split('/') : ['', pkg]
  const basedir = resolve(fixturesDir, directory, `node_modules/${namespace}`)
  const destination = resolve(basedir, name)

  await createDirectory(basedir)
  if (!existsSync(destination)) {
    await symlink(source, destination, 'dir')
  }
}

export async function createRuntime (t, path, packageRoot) {
  const configFile = resolve(fixturesDir, path)

  if (packageRoot) {
    const packageName = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf-8')).name
    const root = dirname(configFile)
    await ensureDependency(root, packageName, packageRoot)
  }

  const config = await loadConfig({}, ['-c', configFile], platformaticRuntime)
  const runtime = await buildServer(config.configManager.current)
  const url = await runtime.start()

  t.after(async () => {
    await runtime.close()
  })

  return { runtime, url }
}

export async function getLogs (app) {
  const client = new Client(
    {
      hostname: 'localhost',
      protocol: 'http:'
    },
    {
      socketPath: app.getManagementApiUrl(),
      keepAliveTimeout: 10,
      keepAliveMaxTimeout: 10
    }
  )

  // Wait for logs to be written
  await sleep(3000)

  const { statusCode, body } = await client.request({
    method: 'GET',
    path: '/api/v1/logs/all'
  })

  strictEqual(statusCode, 200)

  const rawLogs = await body.text()

  return rawLogs
    .trim()
    .split('\n')
    .filter(l => l)
    .map(m => JSON.parse(m))
}

export async function updateHMRVersion (versionFile) {
  versionFile ??= resolve(fixturesDir, '../tmp/version.js')
  await createDirectory(dirname(versionFile))
  await writeFile(versionFile, `export const version = ${hrmVersion++}\n`, 'utf-8')
}

export async function verifyJSONViaHTTP (baseUrl, path, expectedCode, expectedContent) {
  const { statusCode, body } = await request(baseUrl + path)
  strictEqual(statusCode, expectedCode)
  deepStrictEqual(await body.json(), expectedContent)
}

export async function verifyJSONViaInject (app, serviceId, method, url, expectedCode, expectedContent) {
  const { statusCode, body } = await app.inject(serviceId, { method, url })
  strictEqual(statusCode, expectedCode)
  deepStrictEqual(JSON.parse(body), expectedContent)
}

export async function verifyHTMLViaHTTP (baseUrl, path, contents) {
  const { statusCode, headers, body } = await request(baseUrl + path, { maxRedirections: 1 })
  const html = await body.text()

  deepStrictEqual(statusCode, 200)
  ok(headers['content-type']?.startsWith('text/html'))

  for (const content of contents) {
    ok(content instanceof RegExp ? content.test(html) : html.includes(content), content)
  }
}

export async function verifyHTMLViaInject (app, serviceId, url, contents) {
  const { statusCode, headers, body: html } = await app.inject(serviceId, { method: 'GET', url })

  deepStrictEqual(statusCode, 200)
  ok(headers['content-type'].startsWith('text/html'))

  for (const content of contents) {
    ok(content instanceof RegExp ? content.test(html) : html.includes(content), content)
  }
}

export async function verifyHMR (baseUrl, path, protocol, handler) {
  const connection = withResolvers()
  const reload = withResolvers()
  const ac = new AbortController()
  const timeout = sleep(HMR_TIMEOUT, 'timeout', { signal: ac.signal })

  const url = baseUrl.replace('http:', 'ws:') + path
  const webSocket = new WebSocket(url, protocol)

  webSocket.on('error', err => {
    clearTimeout(timeout)
    connection.reject(err)
    reload.reject(err)
  })

  webSocket.on('message', data => {
    handler(JSON.parse(data), connection.resolve, reload.resolve)
  })

  try {
    if ((await Promise.race([connection.promise, timeout])) === 'timeout') {
      throw new Error('Timeout while waiting for HMR connection')
    }

    await sleep(1000)
    await updateHMRVersion()

    if ((await Promise.race([reload.promise, timeout])) === 'timeout') {
      throw new Error('Timeout while waiting for HMR reload')
    }
  } finally {
    webSocket.terminate()
    ac.abort()
  }
}
