import {spawnSync} from 'node:child_process'
import {mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import https from 'node:https'
import {homedir} from 'node:os'
import {join, resolve} from 'node:path'
import {connect as tlsConnect, rootCertificates} from 'node:tls'
import {inflateRawSync} from 'node:zlib'

const MCP_FILE_TYPE = 12
const MAIN_FILE = 'ds-mcp.js'
const CA_FILE = 'ds-ca.pem'
const RELEASE_FILES = new Set([MAIN_FILE, 'README.md', 'THIRD_PARTY_NOTICES.txt', CA_FILE])
const MINIMUM_NODE = [22, 18, 0]
const REQUEST_TIMEOUT_MS = 120000
const TLS_ERRORS = new Set(['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID'])

const USAGE = `Usage: node install.mjs --url <DataSunrise URL> [--dir <folder>] [--mode read|all]
       [--scope user|local|project] [--name <server name>]
       [--ca-file <PEM file> | --trust-fingerprint <SHA-256>]
       node install.mjs --url <DataSunrise URL> --show-certificate

Downloads the MCP server from DataSunrise, checks the connection and registers it in Claude Code.
The access token is read from the DS_TOKEN environment variable.
--show-certificate prints the certificate DataSunrise presents and exits. --trust-fingerprint trusts that
certificate for the download only when its SHA-256 fingerprint matches.`

function fail (message) {
  console.error(`ERROR: ${message}`)
  process.exit(1)
}

function parseArguments (argv) {
  const options = {dir: join(homedir(), 'datasunrise-mcp'), mode: 'read', scope: 'user', name: 'datasunrise'}
  const names = {'--url': 'url', '--dir': 'dir', '--mode': 'mode', '--scope': 'scope', '--name': 'name',
    '--ca-file': 'caFile', '--trust-fingerprint': 'fingerprint'}
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--help' || argv[index] === '-h') {
      console.log(USAGE)
      process.exit(0)
    }
    if (argv[index] === '--show-certificate') {
      options.showCertificate = true
      continue
    }
    const key = names[argv[index]]
    if (!key || index + 1 >= argv.length) fail(`unexpected argument '${argv[index]}'\n\n${USAGE}`)
    options[key] = argv[++index]
  }
  if (!options.url) fail(`--url is required\n\n${USAGE}`)
  if (!['read', 'all'].includes(options.mode)) fail('--mode must be read or all')
  if (!['user', 'local', 'project'].includes(options.scope)) fail('--scope must be user, local or project')
  if (options.caFile && options.fingerprint) fail('use either --ca-file or --trust-fingerprint')
  return options
}

function baseUrl (text) {
  let url
  try {
    url = new URL(text)
  } catch {
    fail(`'${text}' is not a URL`)
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    fail('the DataSunrise URL must be an HTTPS address without credentials, query or fragment: ' +
      'DataSunrise accepts access tokens only over HTTPS')
  }
  return url.origin + url.pathname.replace(/\/+$/, '')
}

function checkNodeVersion () {
  const current = process.versions.node.split('.').map(Number)
  for (let index = 0; index < MINIMUM_NODE.length; index++) {
    if (current[index] > MINIMUM_NODE[index]) return
    if (current[index] < MINIMUM_NODE[index]) {
      fail(`Node.js ${MINIMUM_NODE.join('.')} or newer is required, this is ${process.versions.node}`)
    }
  }
}

function request (url, {method = 'GET', headers = {}, body, ca}) {
  const target = new URL(url)
  const options = {method, headers, timeout: REQUEST_TIMEOUT_MS}
  if (ca) {
    options.ca = [...rootCertificates, ca]
    options.allowPartialTrustChain = true
  }
  return new Promise((resolvePromise, reject) => {
    const outgoing = https.request(target, options, incoming => {
      const chunks = []
      incoming.on('data', chunk => chunks.push(chunk))
      incoming.on('error', reject)
      incoming.on('end', () => resolvePromise({status: incoming.statusCode, body: Buffer.concat(chunks)}))
    })
    outgoing.on('timeout', () => outgoing.destroy(Object.assign(new Error('timed out'), {code: 'ETIMEDOUT'})))
    outgoing.on('error', reject)
    outgoing.end(body)
  }).catch(error => {
    if (error.code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
      fail(`the certificate of ${target.host} is not issued for '${target.hostname}' (${error.reason}). ` +
        'Use a URL with a name the certificate lists, or give DataSunrise a certificate for this name. ' +
        '--show-certificate prints the names.')
    }
    if (TLS_ERRORS.has(error.code)) {
      fail(`the TLS certificate of ${target.host} could not be verified (${error.code}). ` +
        'Check it with --show-certificate, then pass --trust-fingerprint or --ca-file.')
    }
    fail(`could not reach ${target.host}: ${error.code || error.message}`)
  })
}

function normalizeFingerprint (text) {
  return text.replace(/[^0-9a-fA-F]/g, '').toUpperCase()
}

function fetchCertificate (base) {
  const url = new URL(base)
  const isAddress = /^[\d.]+$|:/.test(url.hostname)
  return new Promise((resolvePromise, reject) => {
    const socket = tlsConnect({host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 443),
      servername: isAddress ? undefined : url.hostname, rejectUnauthorized: false, timeout: REQUEST_TIMEOUT_MS})
    socket.on('secureConnect', () => {
      const certificate = socket.getPeerCertificate()
      socket.end()
      if (!certificate?.raw) reject(new Error('no certificate'))
      else resolvePromise(certificate)
    })
    socket.on('timeout', () => socket.destroy(new Error('timed out')))
    socket.on('error', reject)
  }).catch(error => fail(`could not read the certificate of ${url.host}: ${error.code || error.message}`))
}

function certificatePem (certificate) {
  const body = certificate.raw.toString('base64').match(/.{1,64}/g).join('\n')
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`
}

function describeCertificate (certificate) {
  const name = fields => Object.entries(fields || {}).map(([key, value]) => `${key}=${value}`).join(', ')
  return [`Subject: ${name(certificate.subject)}`, `Issuer: ${name(certificate.issuer)}`,
    `Names: ${certificate.subjectaltname || 'none'}`, `Valid: ${certificate.valid_from} - ${certificate.valid_to}`,
    `SHA-256 fingerprint: ${certificate.fingerprint256}`].join('\n')
}

async function trustedCertificate (base, fingerprint) {
  const certificate = await fetchCertificate(base)
  if (normalizeFingerprint(certificate.fingerprint256) !== normalizeFingerprint(fingerprint)) {
    fail(`the certificate of ${new URL(base).host} does not match the fingerprint, nothing was downloaded\n` +
      describeCertificate(certificate))
  }
  return certificatePem(certificate)
}

function createRpc (base, token, ca) {
  let queryId = 0
  return async (func, data) => {
    const response = await request(`${base}/api`, {
      method: 'POST', ca, body: JSON.stringify({queryID: ++queryId, func, data}),
      headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`}
    })
    if (response.status === 401 || response.status === 403) {
      fail(`${func}: DataSunrise refused access. Check that the token is valid and not expired or revoked.`)
    }
    if (response.status !== 200) fail(`${func}: DataSunrise returned HTTP ${response.status}. Check the URL.`)
    let result
    try {
      result = JSON.parse(response.body.toString('utf8'))
    } catch {
      fail(`${func}: the answer is not JSON. Check that the URL points to the DataSunrise backend.`)
    }
    if (result.error !== undefined && result.error !== 'ok') {
      fail(`${func}: ${result.errorDesc || result.error}`)
    }
    return result
  }
}

async function downloadArchive (base, token, ca) {
  const rpc = createRpc(base, token, ca)
  const {url} = await rpc('getFileURL', {type: MCP_FILE_TYPE})
  if (!url) fail('getFileURL returned no download link')
  const downloadUrl = new URL(url, `${base}/`)
  const requested = new URL(base)
  if (downloadUrl.protocol !== requested.protocol || downloadUrl.hostname !== requested.hostname) {
    downloadUrl.protocol = requested.protocol
    downloadUrl.host = requested.host
  }
  const response = await request(downloadUrl.href, {ca, headers: {Authorization: `Bearer ${token}`}})
  if (response.status === 403 || response.status === 404 || response.status === 409) {
    fail(`the download was answered by another DataSunrise node (HTTP ${response.status}). ` +
      'Use the URL of one node instead of a load balancer without sticky sessions.')
  }
  if (response.status !== 200) fail(`the MCP download returned HTTP ${response.status}`)
  return response.body
}

function parseZip (archive) {
  const endSignature = 0x06054b50
  let end = -1
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 65557); offset--) {
    if (archive.readUInt32LE(offset) === endSignature) {
      end = offset
      break
    }
  }
  if (end < 0) fail('the downloaded file is not a ZIP archive')
  const count = archive.readUInt16LE(end + 10)
  let offset = archive.readUInt32LE(end + 16)
  const files = new Map()
  for (let index = 0; index < count; index++) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) fail('the ZIP archive is damaged')
    const method = archive.readUInt16LE(offset + 10)
    const compressedSize = archive.readUInt32LE(offset + 20)
    const nameLength = archive.readUInt16LE(offset + 28)
    const extraLength = archive.readUInt16LE(offset + 30)
    const commentLength = archive.readUInt16LE(offset + 32)
    const localOffset = archive.readUInt32LE(offset + 42)
    const name = archive.toString('utf8', offset + 46, offset + 46 + nameLength)
    offset += 46 + nameLength + extraLength + commentLength

    if (!RELEASE_FILES.has(name)) fail(`unexpected file '${name}' in the MCP archive`)
    if (archive.readUInt32LE(localOffset) !== 0x04034b50) fail('the ZIP archive is damaged')
    const dataOffset = localOffset + 30 + archive.readUInt16LE(localOffset + 26) + archive.readUInt16LE(localOffset + 28)
    const data = archive.subarray(dataOffset, dataOffset + compressedSize)
    if (method === 0) files.set(name, data)
    else if (method === 8) files.set(name, inflateRawSync(data))
    else fail(`unsupported compression in the MCP archive for '${name}'`)
  }
  if (!files.has(MAIN_FILE)) fail(`${MAIN_FILE} is missing from the MCP archive`)
  return files
}

function readZip (archive) {
  try {
    return parseZip(archive)
  } catch (error) {
    fail(`the MCP archive is damaged: ${error.message}`)
  }
}

function install (files, directory) {
  mkdirSync(directory, {recursive: true})
  for (const name of RELEASE_FILES) {
    const path = join(directory, name)
    if (files.has(name)) writeFileSync(path, files.get(name))
    else rmSync(path, {force: true})
  }
}

function runChecked (command, args, token, description) {
  const result = spawnSync(command, args, {env: {...process.env, DS_TOKEN: token}, encoding: 'utf8'})
  if (result.error) fail(`could not run ${command}: ${result.error.code || result.error.message}`)
  const output = `${result.stdout || ''}${result.stderr || ''}`.split(token).join('***').trim()
  if (output) console.log(output)
  if (result.status !== 0) fail(`${description} failed`)
}

async function main () {
  const options = parseArguments(process.argv.slice(2))
  const base = baseUrl(options.url)
  if (options.showCertificate) {
    console.log(describeCertificate(await fetchCertificate(base)))
    return
  }
  const token = process.env.DS_TOKEN || ''
  if (!token) fail('DS_TOKEN is not set')
  checkNodeVersion()
  let ca
  if (options.caFile) ca = readFileSync(options.caFile, 'utf8')
  else if (options.fingerprint) ca = await trustedCertificate(base, options.fingerprint)
  const directory = resolve(options.dir)
  const server = join(directory, MAIN_FILE)

  console.log(`Downloading the MCP server from ${base}`)
  const files = readZip(await downloadArchive(base, token, ca))
  install(files, directory)
  console.log(`Installed ${[...files.keys()].join(', ')} into ${directory}`)

  console.log('Checking the connection')
  runChecked(process.execPath, [server, '--check', '--url', base], token, 'the connection check')

  const config = {type: 'stdio', command: 'node', args: [server], env: {DS_URL: base, DS_MCP_MODE: options.mode,
    DS_TOKEN: token}}
  spawnSync('claude', ['mcp', 'remove', options.name, '--scope', options.scope], {encoding: 'utf8'})
  runChecked('claude', ['mcp', 'add-json', options.name, JSON.stringify(config), '--scope', options.scope], token,
    'registering the MCP server in Claude Code')
  console.log(`Registered '${options.name}' (${options.mode} mode, ${options.scope} scope). Start a new session.`)
}

main()
