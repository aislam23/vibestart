import { createServer } from 'node:net'

import {
  preferredBackendPort,
  preferredKongPort,
  preferredPostgresPort,
  preferredWebPort,
} from './env'

export type PortPlan = {
  backendPort: number
  kongPort: number
  postgresPort: number
  webPort: number
}

/** Scans forward from each preferred port for a free one, so a leftover process (or a second
 * concurrent run) never blocks this one - mirrors the free-port scan a real deploy would do, just
 * scoped to loopback. Each env var below is an explicit escape hatch for CI or a fixed local
 * setup; unset, every port is auto-selected. */
export async function resolveE2ePorts(): Promise<PortPlan> {
  const reservedPorts = new Set<number>()

  const kongPort = await resolvePort({
    envName: 'E2E_KONG_PORT',
    preferredPort: preferredKongPort,
    reservedPorts,
  })
  const postgresPort = await resolvePort({
    envName: 'E2E_POSTGRES_PORT',
    preferredPort: preferredPostgresPort,
    reservedPorts,
  })
  const backendPort = await resolvePort({
    envName: 'E2E_BACKEND_PORT',
    preferredPort: preferredBackendPort,
    reservedPorts,
  })
  const webPort = await resolvePort({
    envName: 'E2E_WEB_PORT',
    preferredPort: preferredWebPort,
    reservedPorts,
  })

  return { backendPort, kongPort, postgresPort, webPort }
}

async function resolvePort(input: {
  envName: string
  preferredPort: number
  reservedPorts: Set<number>
}): Promise<number> {
  const explicitPort = process.env[input.envName]
  if (explicitPort !== undefined) {
    const parsedPort = parsePort(explicitPort, input.envName)
    input.reservedPorts.add(parsedPort)
    return parsedPort
  }

  for (let offset = 0; offset < 1_000; offset += 1) {
    const candidatePort = input.preferredPort + offset
    if (input.reservedPorts.has(candidatePort)) continue
    if (await isPortAvailable(candidatePort)) {
      input.reservedPorts.add(candidatePort)
      return candidatePort
    }
  }

  throw new Error(`Could not find a free ${input.envName} port near ${input.preferredPort}.`)
}

function parsePort(value: string, envName: string): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`${envName} must be a valid TCP port, got "${value}".`)
  }
  return port
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolveAvailability) => {
    const server = createServer()
    server.once('error', () => resolveAvailability(false))
    server.once('listening', () => {
      server.close(() => resolveAvailability(true))
    })
    server.listen({ host: '127.0.0.1', port })
  })
}
