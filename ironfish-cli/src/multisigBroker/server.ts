/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { ErrorUtils, Logger, YupUtils } from '@ironfish/sdk'
import net from 'net'
import { IMultisigBrokerAdapter } from './adapters'
import { ClientMessageMalformedError } from './errors'
import {
  ConnectedMessage,
  DkgGetStatusSchema,
  DkgStartSessionSchema,
  DkgStatusMessage,
  IdentitySchema,
  MultisigBrokerAckMessage,
  MultisigBrokerMessage,
  MultisigBrokerMessageSchema,
  MultisigBrokerMessageWithError,
  Round1PublicPackageSchema,
  Round2PublicPackageSchema,
  SignatureShareSchema,
  SigningCommitmentSchema,
  SigningGetStatusSchema,
  SigningStartSessionSchema,
  SigningStatusMessage,
} from './messages'
import { MultisigServerClient } from './serverClient'

enum MultisigSessionType {
  DKG = 'DKG',
  SIGNING = 'SIGNING',
}

interface MultisigSession {
  id: string
  type: MultisigSessionType
  status: DkgStatus | SigningStatus
}

interface DkgSession extends MultisigSession {
  type: MultisigSessionType.DKG
  status: DkgStatus
}

interface SigningSession extends MultisigSession {
  type: MultisigSessionType.SIGNING
  status: SigningStatus
}

export type DkgStatus = {
  minSigners: number
  maxSigners: number
  identities: string[]
  round1PublicPackages: string[]
  round2PublicPackages: string[]
}

export type SigningStatus = {
  numSigners: number
  unsignedTransaction: string
  identities: string[]
  signingCommitments: string[]
  signatureShares: string[]
}

export class MultisigServer {
  readonly logger: Logger
  readonly adapters: IMultisigBrokerAdapter[] = []

  clients: Map<number, MultisigServerClient>
  nextClientId: number
  nextMessageId: number

  sessions: Map<string, MultisigSession> = new Map()

  private _isRunning = false
  private _startPromise: Promise<unknown> | null = null

  constructor(options: { logger: Logger; banning?: boolean }) {
    this.logger = options.logger

    this.clients = new Map()
    this.nextClientId = 1
    this.nextMessageId = 1
  }

  get isRunning(): boolean {
    return this._isRunning
  }

  /** Starts the MultisigBroker server and tells any attached adapters to start serving requests */
  async start(): Promise<void> {
    if (this._isRunning) {
      return
    }

    this._startPromise = Promise.all(this.adapters.map((a) => a.start()))
    this._isRunning = true
    await this._startPromise
  }

  /** Stops the MultisigBroker server and tells any attached adapters to stop serving requests */
  async stop(): Promise<void> {
    if (!this._isRunning) {
      return
    }

    if (this._startPromise) {
      await this._startPromise
    }

    await Promise.all(this.adapters.map((a) => a.stop()))
    this._isRunning = false
  }

  /** Adds an adapter to the MultisigBroker server and starts it if the server has already been started */
  mount(adapter: IMultisigBrokerAdapter): void {
    this.adapters.push(adapter)
    adapter.attach(this)

    if (this._isRunning) {
      let promise: Promise<unknown> = adapter.start()

      if (this._startPromise) {
        // Attach this promise to the start promise chain
        // in case we call stop while were still starting up
        promise = Promise.all([this._startPromise, promise])
      }

      this._startPromise = promise
    }
  }

  onConnection(socket: net.Socket): void {
    const client = MultisigServerClient.accept(socket, this.nextClientId++)

    socket.on('data', (data: Buffer) => {
      this.onData(client, data).catch((e) => this.onError(client, e))
    })

    socket.on('close', () => this.onDisconnect(client))
    socket.on('error', (e) => this.onError(client, e))

    this.send(socket, 'connected', '0', {})

    this.logger.debug(`Client ${client.id} connected: ${client.remoteAddress}`)
    this.clients.set(client.id, client)
  }

  private onDisconnect(client: MultisigServerClient): void {
    this.logger.debug(`Client ${client.id} disconnected  (${this.clients.size - 1} total)`)

    this.clients.delete(client.id)
    client.close()
    client.socket.removeAllListeners('close')
    client.socket.removeAllListeners('error')

    if (client.sessionId && !this.isSessionActive(client.sessionId)) {
      this.cleanupSession(client.sessionId)
    }
  }

  private async onData(client: MultisigServerClient, data: Buffer): Promise<void> {
    client.messageBuffer.write(data)

    for (const split of client.messageBuffer.readMessages()) {
      const payload: unknown = JSON.parse(split)
      const { error: parseError, result: message } = await YupUtils.tryValidate(
        MultisigBrokerMessageSchema,
        payload,
      )

      if (parseError) {
        this.sendErrorMessage(client, 0, `Error parsing message`)
        return
      }

      this.logger.debug(`Client ${client.id} sent ${message.method} message`)
      this.send(client.socket, 'ack', message.sessionId, { messageId: message.id })

      if (message.method === 'dkg.start_session') {
        await this.handleDkgStartSessionMessage(client, message)
        return
      } else if (message.method === 'sign.start_session') {
        await this.handleSigningStartSessionMessage(client, message)
        return
      } else if (message.method === 'join_session') {
        this.handleJoinSessionMessage(client, message)
        return
      } else if (message.method === 'dkg.identity') {
        await this.handleDkgIdentityMessage(client, message)
        return
      } else if (message.method === 'dkg.round1') {
        await this.handleRound1PublicPackageMessage(client, message)
        return
      } else if (message.method === 'dkg.round2') {
        await this.handleRound2PublicPackageMessage(client, message)
        return
      } else if (message.method === 'dkg.get_status') {
        await this.handleDkgGetStatusMessage(client, message)
        return
      } else if (message.method === 'sign.identity') {
        await this.handleSigningIdentityMessage(client, message)
        return
      } else if (message.method === 'sign.commitment') {
        await this.handleSigningCommitmentMessage(client, message)
        return
      } else if (message.method === 'sign.share') {
        await this.handleSignatureShareMessage(client, message)
        return
      } else if (message.method === 'sign.get_status') {
        await this.handleSigningGetStatusMessage(client, message)
        return
      } else {
        throw new ClientMessageMalformedError(client, `Invalid message ${message.method}`)
      }
    }
  }

  private onError(client: MultisigServerClient, error: unknown): void {
    this.logger.debug(
      `Error during handling of data from client ${client.id}: ${ErrorUtils.renderError(
        error,
        true,
      )}`,
    )

    client.socket.removeAllListeners()
    client.close()

    this.clients.delete(client.id)
  }

  /**
   * If a client has the given session ID and is connected, the associated
   * session should still be considered active
   */
  private isSessionActive(sessionId: string): boolean {
    for (const client of this.clients.values()) {
      if (client.connected && client.sessionId && client.sessionId === sessionId) {
        return true
      }
    }
    return false
  }

  private cleanupSession(sessionId: string): void {
    this.sessions.delete(sessionId)
    this.logger.debug(`Session ${sessionId} cleaned up. Active sessions: ${this.sessions.size}`)
  }

  private broadcast(method: 'dkg.status', sessionId: string, body?: DkgStatusMessage): void
  private broadcast(method: 'sign.status', sessionId: string, body?: SigningStatusMessage): void
  private broadcast(method: string, sessionId: string, body?: unknown): void {
    const message: MultisigBrokerMessage = {
      id: this.nextMessageId++,
      method,
      sessionId,
      body,
    }

    const serialized = JSON.stringify(message) + '\n'

    this.logger.debug('broadcasting to clients', {
      method,
      sessionId,
      id: message.id,
      numClients: this.clients.size,
      messageLength: serialized.length,
    })

    let broadcasted = 0

    for (const client of this.clients.values()) {
      if (client.sessionId !== sessionId) {
        continue
      }

      if (!client.connected) {
        continue
      }

      client.socket.write(serialized)
      broadcasted++
    }

    this.logger.debug('completed broadcast to clients', {
      method,
      sessionId,
      id: message.id,
      numClients: broadcasted,
      messageLength: serialized.length,
    })
  }

  send(
    socket: net.Socket,
    method: 'dkg.status',
    sessionId: string,
    body: DkgStatusMessage,
  ): void
  send(
    socket: net.Socket,
    method: 'sign.status',
    sessionId: string,
    body: SigningStatusMessage,
  ): void
  send(socket: net.Socket, method: 'connected', sessionId: string, body: ConnectedMessage): void
  send(
    socket: net.Socket,
    method: 'ack',
    sessionId: string,
    body: MultisigBrokerAckMessage,
  ): void
  send(socket: net.Socket, method: string, sessionId: string, body?: unknown): void {
    const message: MultisigBrokerMessage = {
      id: this.nextMessageId++,
      method,
      sessionId,
      body,
    }

    const serialized = JSON.stringify(message) + '\n'
    socket.write(serialized)
  }

  sendErrorMessage(client: MultisigServerClient, id: number, message: string): void {
    const msg: MultisigBrokerMessageWithError = {
      id: this.nextMessageId++,
      error: {
        id: id,
        message: message,
      },
    }
    const serialized = JSON.stringify(msg) + '\n'
    client.socket.write(serialized)
  }

  async handleDkgStartSessionMessage(
    client: MultisigServerClient,
    message: MultisigBrokerMessage,
  ) {
    const body = await YupUtils.tryValidate(DkgStartSessionSchema, message.body)

    if (body.error) {
      return
    }

    const sessionId = message.sessionId

    if (this.sessions.has(sessionId)) {
      this.sendErrorMessage(client, message.id, `Duplicate sessionId: ${sessionId}`)
      return
    }

    const session = {
      id: sessionId,
      type: MultisigSessionType.DKG,
      status: {
        maxSigners: body.result.maxSigners,
        minSigners: body.result.minSigners,
        identities: [],
        round1PublicPackages: [],
        round2PublicPackages: [],
      },
    }

    this.sessions.set(sessionId, session)

    this.logger.debug(`Client ${client.id} started dkg session ${message.sessionId}`)

    client.sessionId = message.sessionId
  }

  async handleSigningStartSessionMessage(
    client: MultisigServerClient,
    message: MultisigBrokerMessage,
  ) {
    const body = await YupUtils.tryValidate(SigningStartSessionSchema, message.body)

    if (body.error) {
      return
    }

    const sessionId = message.sessionId

    if (this.sessions.has(sessionId)) {
      this.sendErrorMessage(client, message.id, `Duplicate sessionId: ${sessionId}`)
      return
    }

    const session = {
      id: sessionId,
      type: MultisigSessionType.SIGNING,
      status: {
        numSigners: body.result.numSigners,
        unsignedTransaction: body.result.unsignedTransaction,
        identities: [],
        signingCommitments: [],
        signatureShares: [],
      },
    }

    this.sessions.set(sessionId, session)

    this.logger.debug(`Client ${client.id} started signing session ${message.sessionId}`)

    client.sessionId = message.sessionId
  }

  handleJoinSessionMessage(client: MultisigServerClient, message: MultisigBrokerMessage) {
    if (!this.sessions.has(message.sessionId)) {
      this.sendErrorMessage(client, message.id, `Session not found: ${message.sessionId}`)
      return
    }

    this.logger.debug(`Client ${client.id} joined session ${message.sessionId}`)

    client.sessionId = message.sessionId
  }

  async handleDkgIdentityMessage(client: MultisigServerClient, message: MultisigBrokerMessage) {
    const body = await YupUtils.tryValidate(IdentitySchema, message.body)

    if (body.error) {
      return
    }

    const session = this.sessions.get(message.sessionId)
    if (!session) {
      this.sendErrorMessage(client, message.id, `Session not found: ${message.sessionId}`)
      return
    }

    if (!isDkgSession(session)) {
      this.sendErrorMessage(
        client,
        message.id,
        `Session is not a dkg session: ${message.sessionId}`,
      )
      return
    }

    const identity = body.result.identity
    if (!session.status.identities.includes(identity)) {
      session.status.identities.push(identity)
      this.sessions.set(message.sessionId, session)

      // Broadcast status after collecting all identities
      if (session.status.identities.length === session.status.maxSigners) {
        this.broadcast('dkg.status', message.sessionId, session.status)
      }
    }
  }

  async handleSigningIdentityMessage(
    client: MultisigServerClient,
    message: MultisigBrokerMessage,
  ) {
    const body = await YupUtils.tryValidate(IdentitySchema, message.body)

    if (body.error) {
      return
    }

    const session = this.sessions.get(message.sessionId)
    if (!session) {
      this.sendErrorMessage(client, message.id, `Session not found: ${message.sessionId}`)
      return
    }

    if (!isSigningSession(session)) {
      this.sendErrorMessage(
        client,
        message.id,
        `Session is not a signing session: ${message.sessionId}`,
      )
      return
    }

    const identity = body.result.identity
    if (!session.status.identities.includes(identity)) {
      session.status.identities.push(identity)
      this.sessions.set(message.sessionId, session)

      // Broadcast status after collecting all identities
      if (session.status.identities.length === session.status.numSigners) {
        this.broadcast('sign.status', message.sessionId, session.status)
      }
    }
  }

  async handleRound1PublicPackageMessage(
    client: MultisigServerClient,
    message: MultisigBrokerMessage,
  ) {
    const body = await YupUtils.tryValidate(Round1PublicPackageSchema, message.body)

    if (body.error) {
      return
    }

    const session = this.sessions.get(message.sessionId)
    if (!session) {
      this.sendErrorMessage(client, message.id, `Session not found: ${message.sessionId}`)
      return
    }

    if (!isDkgSession(session)) {
      this.sendErrorMessage(
        client,
        message.id,
        `Session is not a dkg session: ${message.sessionId}`,
      )
      return
    }

    const round1PublicPackage = body.result.package
    if (!session.status.round1PublicPackages.includes(round1PublicPackage)) {
      session.status.round1PublicPackages.push(round1PublicPackage)
      this.sessions.set(message.sessionId, session)

      // Broadcast status after collecting all packages
      if (session.status.round1PublicPackages.length === session.status.maxSigners) {
        this.broadcast('dkg.status', message.sessionId, session.status)
      }
    }
  }

  async handleRound2PublicPackageMessage(
    client: MultisigServerClient,
    message: MultisigBrokerMessage,
  ) {
    const body = await YupUtils.tryValidate(Round2PublicPackageSchema, message.body)

    if (body.error) {
      return
    }

    const session = this.sessions.get(message.sessionId)
    if (!session) {
      this.sendErrorMessage(client, message.id, `Session not found: ${message.sessionId}`)
      return
    }

    if (!isDkgSession(session)) {
      this.sendErrorMessage(
        client,
        message.id,
        `Session is not a dkg session: ${message.sessionId}`,
      )
      return
    }

    const round2PublicPackage = body.result.package
    if (!session.status.round2PublicPackages.includes(round2PublicPackage)) {
      session.status.round2PublicPackages.push(round2PublicPackage)
      this.sessions.set(message.sessionId, session)

      // Broadcast status after collecting all packages
      if (session.status.round2PublicPackages.length === session.status.maxSigners) {
        this.broadcast('dkg.status', message.sessionId, session.status)
      }
    }
  }

  async handleDkgGetStatusMessage(
    client: MultisigServerClient,
    message: MultisigBrokerMessage,
  ) {
    const body = await YupUtils.tryValidate(DkgGetStatusSchema, message.body)

    if (body.error) {
      return
    }

    const session = this.sessions.get(message.sessionId)
    if (!session) {
      this.sendErrorMessage(client, message.id, `Session not found: ${message.sessionId}`)
      return
    }

    if (!isDkgSession(session)) {
      this.sendErrorMessage(
        client,
        message.id,
        `Session is not a dkg session: ${message.sessionId}`,
      )
      return
    }

    this.send(client.socket, 'dkg.status', message.sessionId, session.status)
  }

  async handleSigningCommitmentMessage(
    client: MultisigServerClient,
    message: MultisigBrokerMessage,
  ) {
    const body = await YupUtils.tryValidate(SigningCommitmentSchema, message.body)

    if (body.error) {
      return
    }

    const session = this.sessions.get(message.sessionId)
    if (!session) {
      this.sendErrorMessage(client, message.id, `Session not found: ${message.sessionId}`)
      return
    }

    if (!isSigningSession(session)) {
      this.sendErrorMessage(
        client,
        message.id,
        `Session is not a signing session: ${message.sessionId}`,
      )
      return
    }

    const signingCommitment = body.result.signingCommitment
    if (!session.status.signingCommitments.includes(signingCommitment)) {
      session.status.signingCommitments.push(signingCommitment)
      this.sessions.set(message.sessionId, session)

      // Broadcast status after collecting all signing commitments
      if (session.status.signingCommitments.length === session.status.numSigners) {
        this.broadcast('sign.status', message.sessionId, session.status)
      }
    }
  }

  async handleSignatureShareMessage(
    client: MultisigServerClient,
    message: MultisigBrokerMessage,
  ) {
    const body = await YupUtils.tryValidate(SignatureShareSchema, message.body)

    if (body.error) {
      return
    }

    const session = this.sessions.get(message.sessionId)
    if (!session) {
      this.sendErrorMessage(client, message.id, `Session not found: ${message.sessionId}`)
      return
    }

    if (!isSigningSession(session)) {
      this.sendErrorMessage(
        client,
        message.id,
        `Session is not a signing session: ${message.sessionId}`,
      )
      return
    }

    const signatureShare = body.result.signatureShare
    if (!session.status.signatureShares.includes(signatureShare)) {
      session.status.signatureShares.push(signatureShare)
      this.sessions.set(message.sessionId, session)

      // Broadcast status after collecting all signature shares
      if (session.status.signatureShares.length === session.status.numSigners) {
        this.broadcast('sign.status', message.sessionId, session.status)
      }
    }
  }

  async handleSigningGetStatusMessage(
    client: MultisigServerClient,
    message: MultisigBrokerMessage,
  ) {
    const body = await YupUtils.tryValidate(SigningGetStatusSchema, message.body)

    if (body.error) {
      return
    }

    const session = this.sessions.get(message.sessionId)
    if (!session) {
      this.sendErrorMessage(client, message.id, `Session not found: ${message.sessionId}`)
      return
    }

    if (!isSigningSession(session)) {
      this.sendErrorMessage(
        client,
        message.id,
        `Session is not a signing session: ${message.sessionId}`,
      )
      return
    }

    this.send(client.socket, 'sign.status', message.sessionId, session.status)
  }
}

function isDkgSession(session: MultisigSession): session is DkgSession {
  return session.type === MultisigSessionType.DKG
}

function isSigningSession(session: MultisigSession): session is SigningSession {
  return session.type === MultisigSessionType.SIGNING
}
