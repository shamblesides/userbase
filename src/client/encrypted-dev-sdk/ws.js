import base64 from 'base64-arraybuffer'
import uuidv4 from 'uuid/v4'
import LZString from 'lz-string'
import localData from './localData'
import crypto from './Crypto'

const DEV_MODE = window.location.hostname === 'localhost'

class RequestFailed extends Error {
  constructor(action, response, message, ...params) {
    super(...params)

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, RequestFailed)
    }

    this.name = `RequestFailed: ${action} (${response && response.status})`
    this.message = message || (response && response.data) || 'Error'
    this.response = response
  }
}

class Connection {
  constructor() {
    this.init()
  }

  init(session, onSessionChange, signingUp) {
    for (const property of Object.keys(this)) {
      delete this[property]
    }

    this.ws = null
    this.connected = false

    this.session = session
    this.onSessionChange = onSessionChange

    this.signingUp = signingUp

    this.requests = {}

    this.keys = {
      init: false,
      salts: {}
    }

    this.processingSeedRequest = {}
    this.sentSeedTo = {}

    this.state = {
      databases: {},
      dbIdToHash: {},
      dbNameToHash: {}
    }
  }

  connect(session, onSessionChange, signingUp) {
    if (!session) throw new Error('Missing session')
    if (!session.username) throw new Error('Session missing username')
    if (!session.signedIn) throw new Error('Not signed in to session')

    return new Promise(async (resolve, reject) => {
      let connected = false
      let timeout = false
      setTimeout(
        () => {
          if (!connected) {
            timeout = true
            this.close()
            reject(new Error('timeout'))
          }
        },
        5000
      )

      const url = ((window.location.protocol === 'https:') ?
        'wss://' : 'ws://') + window.location.host + '/api'

      const ws = new WebSocket(url)

      ws.onopen = async () => {
        if (timeout) {
          this.close()
          return
        } else {
          connected = true
          this.init(session, onSessionChange, signingUp)
          this.ws = ws
          this.connected = connected

          if (!session.seed) {
            // re-request seed if already requested
            const alreadySavedRequest = localData.getTempRequestForSeed(session.username)
            if (alreadySavedRequest) {
              const { requesterPublicKey, tempKeyToRequestSeed } = alreadySavedRequest

              const seed = await this.requestSeed(requesterPublicKey, tempKeyToRequestSeed)
              if (seed) return resolve() // already updated session inside receiveSeed()
            }
          }
        }
      }

      ws.onmessage = async (e) => {
        await this.handleMessage(JSON.parse(e.data), resolve)
      }

      ws.onerror = () => {
        if (!connected) {
          if (!DEV_MODE) this.signOut()
          reject(new Error('WebSocket error'))
        } else {
          this.close()
        }
      }

      ws.watch = async (requestId) => {
        this.requests[requestId] = {}

        const response = await new Promise((resolve, reject) => {
          this.requests[requestId].promiseResolve = resolve
          this.requests[requestId].promiseReject = reject

          setTimeout(() => { reject(new Error('timeout')) }, 10000)
        })

        delete this.requests[requestId]

        return response
      }

      ws.onclose = () => {
        this.init(this.session, onSessionChange)
        onSessionChange(this.session)
      }
    })
  }

  async handleMessage(message, resolve) {
    const route = message.route
    switch (route) {
      case 'Connection': {
        const {
          salts,
          encryptedValidationMessage
        } = message

        this.keys.salts = salts
        this.encryptedValidationMessage = new Uint8Array(encryptedValidationMessage.data)

        try {
          await this.setKeys(this.session.seed)
        } catch (e) {
          console.log('Failed to set keys with:', e)
        }

        resolve(this.onSessionChange(this.session))
        break
      }

      case 'ApplyTransactions': {
        const dbId = message.dbId
        const dbNameHash = message.dbNameHash || this.state.dbIdToHash[dbId]
        const database = this.state.databases[dbNameHash]

        if (!database) return

        const openingDatabase = message.dbNameHash && message.dbKey
        if (openingDatabase) {
          const dbKeyString = await crypto.aesGcm.decryptString(this.keys.encryptionKey, message.dbKey)
          database.dbKeyString = dbKeyString
          database.dbKey = await crypto.aesGcm.getKeyFromKeyString(dbKeyString)
        }

        if (!database.dbKey) return

        if (message.bundle) {
          const bundleSeqNo = message.bundleSeqNo
          const base64Bundle = message.bundle
          const compressedString = await crypto.aesGcm.decryptString(database.dbKey, base64Bundle)
          const plaintextString = LZString.decompress(compressedString)
          const bundle = JSON.parse(plaintextString)

          database.applyBundle(bundle, bundleSeqNo)
        }

        const newTransactions = message.transactionLog
        await database.applyTransactions(newTransactions)
        database.onChange(database.getItems())

        if (!database.init) {
          this.state.dbIdToHash[dbId] = dbNameHash
          database.dbId = dbId
          database.init = true
        }

        break
      }

      case 'BuildBundle': {
        const dbId = message.dbId
        const dbNameHash = this.state.dbIdToHash[dbId]
        const database = this.state.databases[dbNameHash]

        if (!database) return

        const bundle = {
          items: database.items,
          itemsIndex: database.itemsIndex.array
        }

        const itemKeys = []

        for (let i = 0; i < bundle.itemsIndex.length; i++) {
          const itemId = bundle.itemsIndex[i].itemId
          const itemKey = await crypto.hmac.signString(this.keys.hmacKey, itemId)
          itemKeys.push(itemKey)
        }

        const plaintextString = JSON.stringify(bundle)
        const compressedString = LZString.compress(plaintextString)
        const base64Bundle = await crypto.aesGcm.encryptString(database.dbKey, compressedString)

        const action = 'Bundle'
        const params = { dbId, seqNo: database.lastSeqNo, bundle: base64Bundle, keys: itemKeys }
        this.request(action, params)

        break
      }

      case 'ReceiveRequestForSeed': {
        if (!this.keys.init) return

        const requesterPublicKey = message.requesterPublicKey
        this.sendSeed(requesterPublicKey)

        break
      }

      case 'ReceiveSeed': {
        const { encryptedSeed, senderPublicKey } = message
        const { tempKeyToRequestSeed, requesterPublicKey } = localData.getTempRequestForSeed(this.session.username)

        await this.receiveSeed(
          encryptedSeed,
          senderPublicKey,
          requesterPublicKey,
          tempKeyToRequestSeed
        )

        break
      }

      case 'CreateDatabase':
      case 'GetDatabase':
      case 'OpenDatabase':
      case 'FindDatabases':
      case 'Insert':
      case 'Update':
      case 'Delete':
      case 'Batch':
      case 'Bundle':
      case 'ValidateKey':
      case 'RequestSeed':
      case 'GetRequestsForSeed':
      case 'SendSeed':
      case 'GetPublicKey':
      case 'GrantDatabaseAccess':
      case 'GetDatabaseAccessGrants':
      case 'AcceptDatabaseAccess': {
        const requestId = message.requestId

        if (!requestId) return console.warn('Missing request id')

        const request = this.requests[requestId]
        if (!request) return console.warn(`Request ${requestId} no longer exists!`)
        else if (!request.promiseResolve || !request.promiseReject) return

        const response = message.response

        const successfulResponse = response && response.status === 200

        if (!successfulResponse) return request.promiseReject(response)
        else return request.promiseResolve(response)
      }

      default: {
        console.log('Received unknown message from backend:' + JSON.stringify(message))
        break
      }
    }
  }

  close() {
    this.ws
      ? this.ws.close()
      : this.init(this.session, this.onSessionChange)
  }

  signOut() {
    if (!this.session || !this.session.username) return
    localData.signOutSession(this.session.username)

    this.session.signedIn = false

    this.close()
    this.onSessionChange(this.session)
  }

  async setKeys(seedString, requesterPublicKey) {
    if (!seedString) throw new Error('Missing seed')
    if (!this.keys.salts) throw new Error('Missing salts')
    if (!this.session.seed) this.session.seed = seedString

    this.keys.seedString = seedString

    const seed = base64.decode(seedString)
    const masterKey = await crypto.hkdf.importMasterKey(seed)

    const salts = this.keys.salts
    this.keys.encryptionKey = await crypto.aesGcm.importKeyFromMaster(masterKey, base64.decode(salts.encryptionKeySalt))
    this.keys.dhPrivateKey = await crypto.diffieHellman.importKeyFromMaster(masterKey, base64.decode(salts.dhKeySalt))
    this.keys.hmacKey = await crypto.hmac.importKeyFromMaster(masterKey, base64.decode(salts.hmacKeySalt))

    await this.validateKey(requesterPublicKey)

    this.keys.init = true

    if (!this.signingUp) {
      this.getRequestsForSeed()
      this.getDatabaseAccessGrants()
    }
  }

  async validateKey(requesterPublicKey) {
    const sharedSecret = crypto.diffieHellman.getSharedSecretWithServer(this.keys.dhPrivateKey)

    const sharedRawKey = await crypto.sha256.hash(sharedSecret)
    const sharedKey = await crypto.aesGcm.getKeyFromRawKey(sharedRawKey)

    const validationMessage = base64.encode(await crypto.aesGcm.decrypt(sharedKey, this.encryptedValidationMessage))

    const action = 'ValidateKey'
    const params = {
      validationMessage,
      requesterPublicKey // only provided if first time validating since receving master key
    }
    await this.request(action, params)
  }

  async request(action, params) {
    // generate a new requestId
    const requestId = uuidv4()
    this.requests[requestId] = {}

    // get a promise that is resolved when the WebSocket
    // receives a response for this requestId — the promise
    // would time out of x seconds
    const responseWatcher = this.watch(requestId)

    // send the request on the WebSocket
    this.ws.send(JSON.stringify({
      requestId,
      action,
      params
    }))

    // wait for the response to arrive
    try {
      const response = await responseWatcher
      return response
    } catch (e) {
      // process any errors and re-throw them
      throw new RequestFailed(action, e)
    }
  }

  async watch(requestId) {
    const response = await new Promise((resolve, reject) => {
      this.requests[requestId].promiseResolve = resolve
      this.requests[requestId].promiseReject = reject

      setTimeout(() => { reject(new Error('timeout')) }, 10000)
    })

    delete this.requests[requestId]
    return response
  }

  async requestSeed(requesterPublicKey, tempKeyToRequestSeed) {
    const action = 'RequestSeed'
    const params = { requesterPublicKey }
    const requestSeedResponse = await this.request(action, params)

    const { encryptedSeed, senderPublicKey } = requestSeedResponse.data
    if (encryptedSeed && senderPublicKey) {
      const seed = await this.receiveSeed(encryptedSeed, senderPublicKey, requesterPublicKey, tempKeyToRequestSeed)
      return seed
    }
    return null
  }

  async getRequestsForSeed() {
    if (!this.keys.init) return

    const response = await this.request('GetRequestsForSeed')

    const seedRequests = response.data.seedRequests

    for (const seedRequest of seedRequests) {
      const requesterPublicKey = seedRequest['requester-public-key']

      this.sendSeed(requesterPublicKey)
    }
  }

  async grantDatabaseAccess(database, username, granteePublicKey, readOnly) {
    if (window.confirm(`Grant access to user '${username}' with public key:\n\n${granteePublicKey}\n`)) {
      const sharedSecret = crypto.diffieHellman.getSharedSecret(
        this.keys.dhPrivateKey,
        new Uint8Array(base64.decode(granteePublicKey))
      )

      const sharedRawKey = await crypto.sha256.hash(sharedSecret)
      const sharedKey = await crypto.aesGcm.getKeyFromRawKey(sharedRawKey)

      const encryptedAccessKey = await crypto.aesGcm.encryptString(sharedKey, database.dbKeyString)

      const action = 'GrantDatabaseAccess'
      const params = { username, dbId: database.dbId, encryptedAccessKey, readOnly }
      await this.request(action, params)
    }
  }

  async getDatabaseAccessGrants() {
    if (!this.keys.init) return

    const response = await this.request('GetDatabaseAccessGrants')

    const databaseAccessGrants = response.data

    for (const grant of databaseAccessGrants) {
      const { dbId, ownerPublicKey, encryptedAccessKey, encryptedDbName, owner } = grant

      try {
        const sharedSecret = crypto.diffieHellman.getSharedSecret(
          this.keys.dhPrivateKey,
          new Uint8Array(base64.decode(ownerPublicKey))
        )

        const sharedRawKey = await crypto.sha256.hash(sharedSecret)
        const sharedKey = await crypto.aesGcm.getKeyFromRawKey(sharedRawKey)

        const dbKeyString = await crypto.aesGcm.decryptString(sharedKey, encryptedAccessKey)
        const dbKey = await crypto.aesGcm.getKeyFromKeyString(dbKeyString)

        const dbName = await crypto.aesGcm.decryptString(dbKey, encryptedDbName)

        if (window.confirm(`Accept access to database '${dbName}' from '${owner}' with public key: \n\n${ownerPublicKey}\n`)) {
          await this.acceptDatabaseAccessGrant(dbId, dbKeyString, dbName, encryptedDbName)
        }

      } catch (e) {
        // continue
        console.log(`Error processing database access grants`, e)
      }
    }
  }

  async acceptDatabaseAccessGrant(dbId, dbKeyString, dbName, encryptedDbName) {
    if (!this.keys.init) return

    const dbNameHash = await crypto.hmac.signString(this.keys.hmacKey, dbName)
    const encryptedDbKey = await crypto.aesGcm.encryptString(this.keys.encryptionKey, dbKeyString)

    const action = 'AcceptDatabaseAccess'
    const params = { dbId, encryptedDbKey, dbNameHash, encryptedDbName }

    await this.request(action, params)
  }

  async sendSeed(requesterPublicKey) {
    if (this.sentSeedTo[requesterPublicKey] || this.processingSeedRequest[requesterPublicKey]) return
    this.processingSeedRequest[requesterPublicKey] = true

    if (window.confirm(`Send the seed to device: \n\n${requesterPublicKey}\n`)) {
      try {
        const sharedSecret = crypto.diffieHellman.getSharedSecret(
          this.keys.dhPrivateKey,
          new Uint8Array(base64.decode(requesterPublicKey))
        )

        const sharedRawKey = await crypto.sha256.hash(sharedSecret)
        const sharedKey = await crypto.aesGcm.getKeyFromRawKey(sharedRawKey)

        const encryptedSeed = await crypto.aesGcm.encryptString(sharedKey, this.keys.seedString)

        const action = 'SendSeed'
        const params = { requesterPublicKey, encryptedSeed }

        await this.request(action, params)
        this.sentSeedTo[requesterPublicKey] = true
      } catch (e) {
        console.warn(e)
      }
    }
    delete this.processingSeedRequest[requesterPublicKey]
  }

  async receiveSeed(encryptedSeed, senderPublicKey, requesterPublicKey, tempKeyToRequestSeed) {
    const sharedSecret = crypto.diffieHellman.getSharedSecret(
      tempKeyToRequestSeed,
      new Uint8Array(base64.decode(senderPublicKey))
    )

    const sharedRawKey = await crypto.sha256.hash(sharedSecret)
    const sharedKey = await crypto.aesGcm.getKeyFromRawKey(sharedRawKey)

    const seedString = await crypto.aesGcm.decryptString(sharedKey, encryptedSeed)

    await localData.saveSeedStringToLocalStorage(this.session.username, seedString)

    await this.setKeys(seedString, requesterPublicKey)

    localData.removeRequestForSeed(this.session.username)

    this.onSessionChange(this.session)
    return seedString
  }
}

export default new Connection()