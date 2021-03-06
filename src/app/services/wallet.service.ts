import { Injectable } from '@angular/core';
import {UtilService} from "./util.service";
import {ApiService} from "./api.service";
import {BigNumber} from 'bignumber.js';
import {AddressBookService} from "./address-book.service";
import * as CryptoJS from 'crypto-js';
import {WorkPoolService} from "./work-pool.service";
import {WebsocketService} from "./websocket.service";
import {BananoBlockService} from "./nano-block.service";
import {NotificationService} from "./notification.service";
import {AppSettingsService} from "./app-settings.service";
import {PriceService} from "./price.service";
import {LedgerService} from "./ledger.service";

export type WalletType = "seed" | "ledger" | "privateKey";

export interface WalletAccount {
  id: string;
  frontier: string|null;
  secret: any;
  keyPair: any;
  index: number;
  balance: BigNumber;
  pending: BigNumber;
  balanceRaw: BigNumber;
  pendingRaw: BigNumber;
  balanceFiat: number;
  pendingFiat: number;
  addressBookName: string|null;
}
export interface FullWallet {
  type: WalletType;
  seedBytes: any;
  seed: string|null;
  balance: BigNumber;
  pending: BigNumber;
  balanceRaw: BigNumber;
  pendingRaw: BigNumber;
  balanceFiat: number;
  pendingFiat: number;
  accounts: WalletAccount[];
  accountsIndex: number;
  locked: boolean;
  password: string;
}

@Injectable()
export class WalletService {
  banoshi = 1000000000000000000000000000;
  storeKey = `nanovault-wallet`;

  wallet: FullWallet = {
    type: 'seed',
    seedBytes: null,
    seed: '',
    balance: new BigNumber(0),
    pending: new BigNumber(0),
    balanceRaw: new BigNumber(0),
    pendingRaw: new BigNumber(0),
    balanceFiat: 0,
    pendingFiat: 0,
    accounts: [],
    accountsIndex: 0,
    locked: false,
    password: '',
  };

  processingPending = false;
  pendingBlocks = [];
  successfulBlocks = [];

  constructor(
    private util: UtilService,
    private api: ApiService,
    private appSettings: AppSettingsService,
    private addressBook: AddressBookService,
    private price: PriceService,
    private workPool: WorkPoolService,
    private websocket: WebsocketService,
    private bananoBlock: BananoBlockService,
    private ledgerService: LedgerService,
    private notifications: NotificationService)
  {
    this.websocket.newTransactions$.subscribe(async (transaction) => {
      if (!transaction) return; // Not really a new transaction

      // Find out if this is a send, with our account as a destination or not
      const walletAccountIDs = this.wallet.accounts.map(a => a.id);
      if (transaction.block.type == 'send' && walletAccountIDs.indexOf(transaction.block.destination) !== -1) {
        // Perform an automatic receive
        const walletAccount = this.wallet.accounts.find(a => a.id === transaction.block.destination);
        if (walletAccount) {
          // If the wallet is locked, show a notification
          if (this.wallet.locked) {
            this.notifications.sendWarning(`New incoming transaction - unlock the wallet to receive it!`, { length: 0, identifier: 'pending-locked' });
          }
          this.addPendingBlock(walletAccount.id, transaction.hash, transaction.amount);
          await this.processPendingBlocks();
        }
      } else if (transaction.block.type == 'state') {
        await this.processStateBlock(transaction);
      }

      // TODO: We don't really need to call to update balances, we should be able to balance on our own from here

      await this.reloadBalances();
    });

    this.addressBook.addressBook$.subscribe(newAddressBook => {
      this.reloadAddressBook();
    })
  }

  async processStateBlock(transaction) {
    if (transaction.is_send === 'true' && transaction.block.link_as_account) {
      // This is an incoming send block, we want to perform a receive
      const walletAccount = this.wallet.accounts.find(a => a.id === transaction.block.link_as_account);
      if (!walletAccount) return; // Not for our wallet?

      this.addPendingBlock(walletAccount.id, transaction.hash, new BigNumber(0));
      await this.processPendingBlocks();
    } else {
      // Not a send to us, which means it was a block posted by us.  We shouldnt need to do anything...
      const walletAccount = this.wallet.accounts.find(a => a.id === transaction.block.link_as_account);
      if (!walletAccount) return; // Not for our wallet?
    }
  }

  reloadAddressBook() {
    this.wallet.accounts.forEach(account => {
      account.addressBookName = this.addressBook.getAccountName(account.id);
    })
  }

  getWalletAccount(accountID) {
    return this.wallet.accounts.find(a => a.id == accountID);
  }

  async loadStoredWallet() {
    this.resetWallet();

    const walletData = localStorage.getItem(this.storeKey);
    if (!walletData) return this.wallet;

    const walletJson = JSON.parse(walletData);
    const walletType = walletJson.type || 'seed';
    this.wallet.type = walletType;
    if (walletType === 'seed') {
      this.wallet.seed = walletJson.seed;
      this.wallet.seedBytes = this.util.hex.toUint8(walletJson.seed);
    }
    if (walletType === 'seed' || walletType === 'privateKey') {
      this.wallet.locked = walletJson.locked;
      this.wallet.password = walletJson.password || null;
    }
    if (walletType === 'ledger') {
      // Check ledger status?
    }

    this.wallet.accountsIndex = walletJson.accountsIndex || 0;

    if (walletJson.accounts && walletJson.accounts.length) {
      if (walletType === 'ledger' || this.wallet.locked) {
        // With the wallet locked, we load a simpler version of the accounts which does not have the keypairs, and uses the ID as input
        walletJson.accounts.forEach(account => this.loadWalletAccount(account.index, account.id));
      } else {
        await Promise.all(walletJson.accounts.map(async (account) => await this.addWalletAccount(account.index, false)));
      }
    } else {
      // Loading from accounts index
      if (!this.wallet.locked) {
        await this.loadAccountsFromIndex(); // Need to have the seed to reload any accounts if they are not stored
      }
    }

    await this.reloadBalances(true);

    if (walletType === 'ledger') {
      this.ledgerService.loadLedger(true);
    }

    return this.wallet;
  }

  async loadImportedWallet(seed, password, accountsIndex = 1) {
    this.resetWallet();

    this.wallet.seed = seed;
    this.wallet.seedBytes = this.util.hex.toUint8(seed);
    this.wallet.accountsIndex = accountsIndex;
    this.wallet.password = password;

    for (let i = 0; i < accountsIndex; i++) {
      await this.addWalletAccount(i, false);
    }

    await this.reloadBalances(true);

    if (this.wallet.accounts.length) {
      this.websocket.subscribeAccounts(this.wallet.accounts.map(a => a.id));
    }

    return this.wallet;
  }

  async loadAccountsFromIndex() {
    this.wallet.accounts = [];

    for (let i = 0; i < this.wallet.accountsIndex; i++) {
      await this.addWalletAccount(i, false);
    }
  }

  generateExportData() {
    const exportData: any = {
      accountsIndex: this.wallet.accountsIndex,
    };
    if (this.wallet.locked) {
      exportData.seed = this.wallet.seed;
    } else {
      exportData.seed = CryptoJS.AES.encrypt(this.wallet.seed, this.wallet.password).toString();
    }

    return exportData;
  }

  generateExportUrl() {
    const exportData = this.generateExportData();
    const base64Data = btoa(JSON.stringify(exportData));

    return `https://vault.banano.co.in/import-wallet#${base64Data}`;
  }

  lockWallet() {
    if (!this.wallet.seed || !this.wallet.password) return; // Nothing to lock, password not set
    const encryptedSeed = CryptoJS.AES.encrypt(this.wallet.seed, this.wallet.password);

    // Update the seed
    this.wallet.seed = encryptedSeed.toString();
    this.wallet.seedBytes = null;

    // Remove secrets from accounts
    this.wallet.accounts.forEach(a => {
      a.keyPair = null;
      a.secret = null;
    });

    this.wallet.locked = true;
    this.wallet.password = '';

    this.saveWalletExport(); // Save so that a refresh gives you a locked wallet

    return true;
  }
  unlockWallet(password: string) {
    try {
      const decryptedBytes = CryptoJS.AES.decrypt(this.wallet.seed, password);
      const decryptedSeed = decryptedBytes.toString(CryptoJS.enc.Utf8);
      if (!decryptedSeed || decryptedSeed.length !== 64) return false;

      this.wallet.seed = decryptedSeed;
      this.wallet.seedBytes = this.util.hex.toUint8(this.wallet.seed);
      this.wallet.accounts.forEach(a => {
        a.secret = this.util.account.generateAccountSecretKeyBytes(this.wallet.seedBytes, a.index);
        a.keyPair = this.util.account.generateAccountKeyPair(a.secret);
      });

      this.wallet.locked = false;
      this.wallet.password = password;

      this.notifications.removeNotification('pending-locked'); // If there is a notification to unlock, remove it

      // TODO: Determine if we need to load some accounts - should only be used when? Loading from import.
      if (this.wallet.accounts.length < this.wallet.accountsIndex) {
        this.loadAccountsFromIndex().then(() => this.reloadBalances()); // Reload all?
      }

      // Process any pending blocks
      this.processPendingBlocks();

      this.saveWalletExport(); // Save so a refresh also gives you your unlocked wallet?

      return true;
    } catch (err) {
      return false;
    }
  }

  walletIsLocked() {
    return this.wallet.locked;
  }

  async createWalletFromSeed(seed: string, emptyAccountBuffer: number = 10) {
    this.resetWallet();

    this.wallet.seed = seed;
    this.wallet.seedBytes = this.util.hex.toUint8(seed);

    let emptyTicker = 0;
    let usedIndices = [];
    let greatestUsedIndex = 0;
    const batchSize = emptyAccountBuffer + 1;
    for (let batch = 0; emptyTicker < emptyAccountBuffer; batch++) {
      let batchAccounts = {};
      let batchAccountsArray = [];
      for (let i = 0; i < batchSize; i++) {
        const index = batch * batchSize + i;
        const accountBytes = this.util.account.generateAccountSecretKeyBytes(this.wallet.seedBytes, index);
        const accountKeyPair = this.util.account.generateAccountKeyPair(accountBytes);
        const accountAddress = this.util.account.getPublicAccountID(accountKeyPair.publicKey);
        batchAccounts[accountAddress] = {
          index: index,
          publicKey: this.util.uint8.toHex(accountKeyPair.publicKey).toUpperCase(),
          used: false
        };
        batchAccountsArray.push(accountAddress);
      }
      let batchResponse = await this.api.accountsFrontiers(batchAccountsArray);
      for (let accountID in batchResponse.frontiers) {
        const frontier = batchResponse.frontiers[accountID];
        if (frontier !== batchAccounts[accountID].publicKey) {
          batchAccounts[accountID].used = true;
        }
      }
      for (let accountID in batchAccounts) {
        let account = batchAccounts[accountID];
        if (account.used) {
          usedIndices.push(account.index)
          if (account.index > greatestUsedIndex) {
            greatestUsedIndex = account.index
            emptyTicker = 0;
          }
        } else {
          if (account.index > greatestUsedIndex) {
            emptyTicker ++;
          }
        }
      }
    }
    if (usedIndices.length > 0) {
      for (let i = 0; i < usedIndices.length - 1; i++) {
        this.addWalletAccount(usedIndices[i], false);
      }
      this.addWalletAccount(usedIndices.length - 1, true);
    } else{
      this.addWalletAccount();
    }

    return this.wallet.seed;
  }

  createNewWallet() {
    this.resetWallet();

    const seedBytes = this.util.account.generateSeedBytes();
    this.wallet.seedBytes = seedBytes;
    this.wallet.seed = this.util.hex.fromUint8(seedBytes);

    this.addWalletAccount();

    return this.wallet.seed;
  }

  createLedgerWallet() {
    this.resetWallet();
    console.log(`Creating ledger wallet.... ?`);

    this.wallet.type = 'ledger';
    const newAccount = this.addWalletAccount(0);

    return this.wallet;
  }

  async createLedgerAccount(index) {
    console.log(`Creating ledger account at index... `, index);
    const account: any = await this.ledgerService.getLedgerAccount(index);

    console.log(`Got account!`, account);
    const accountID = account.address;
    const addressBookName = this.addressBook.getAccountName(accountID);

    const newAccount: WalletAccount = {
      id: accountID,
      frontier: null,
      secret: null,
      keyPair: null,
      balance: new BigNumber(0),
      pending: new BigNumber(0),
      balanceRaw: new BigNumber(0),
      pendingRaw: new BigNumber(0),
      balanceFiat: 0,
      pendingFiat: 0,
      index: index,
      addressBookName,
    };

    return newAccount;
  }

  async createSeedAccount(index) {
    const accountBytes = this.util.account.generateAccountSecretKeyBytes(this.wallet.seedBytes, index);
    const accountKeyPair = this.util.account.generateAccountKeyPair(accountBytes);
    const accountName = this.util.account.getPublicAccountID(accountKeyPair.publicKey);
    const addressBookName = this.addressBook.getAccountName(accountName);

    const newAccount: WalletAccount = {
      id: accountName,
      frontier: null,
      secret: accountBytes,
      keyPair: accountKeyPair,
      balance: new BigNumber(0),
      pending: new BigNumber(0),
      balanceRaw: new BigNumber(0),
      pendingRaw: new BigNumber(0),
      balanceFiat: 0,
      pendingFiat: 0,
      index: index,
      addressBookName,
    };

    return newAccount;
  }

  /**
   * Reset wallet to a base state, without changing reference to the main object
   */
  resetWallet() {
    if (this.wallet.accounts.length) {
      this.websocket.unsubscribeAccounts(this.wallet.accounts.map(a => a.id)); // Unsubscribe from old accounts
    }
    this.wallet.type = 'seed';
    this.wallet.password = '';
    this.wallet.locked = false;
    this.wallet.seed = '';
    this.wallet.seedBytes = null;
    this.wallet.accounts = [];
    this.wallet.accountsIndex = 0;
    this.wallet.balance = new BigNumber(0);
    this.wallet.pending = new BigNumber(0);
    this.wallet.balanceFiat = 0;
    this.wallet.pendingFiat = 0;
  }

  isConfigured() {
    switch (this.wallet.type) {
      case 'seed': return !!this.wallet.seed;
      case 'ledger': return true; // ?
      case 'privateKey': return false;
    }
  }

  isLocked() {
    switch (this.wallet.type) {
      case 'privateKey':
      case 'seed': return this.wallet.locked;
      case 'ledger': return false;
    }
  }

  isLedgerWallet() {
    return this.wallet.type === 'ledger';
  }

  reloadFiatBalances() {
    const fiatPrice = this.price.price.lastPrice;

    this.wallet.accounts.forEach(account => {
      account.balanceFiat = this.util.banano.rawToBan(account.balance).times(fiatPrice).toNumber();
      account.pendingFiat = this.util.banano.rawToBan(account.pending).times(fiatPrice).toNumber();
    });

    this.wallet.balanceFiat = this.util.banano.rawToBan(this.wallet.balance).times(fiatPrice).toNumber();
    this.wallet.pendingFiat = this.util.banano.rawToBan(this.wallet.pending).times(fiatPrice).toNumber();
  }

  async reloadBalances(reloadPending = true) {
    const fiatPrice = this.price.price.lastPrice;
    this.wallet.balance = new BigNumber(0);
    this.wallet.pending = new BigNumber(0);
    this.wallet.balanceRaw = new BigNumber(0);
    this.wallet.pendingRaw = new BigNumber(0);
    this.wallet.balanceFiat = 0;
    this.wallet.pendingFiat = 0;
    const accountIDs = this.wallet.accounts.map(a => a.id);
    const accounts = await this.api.accountsBalances(accountIDs);
    const frontiers = await this.api.accountsFrontiers(accountIDs);
    // const allFrontiers = [];
    // for (const account in frontiers.frontiers) {
    //   allFrontiers.push({ account, frontier: frontiers.frontiers[account] });
    // }
    // const frontierBlocks = await this.api.blocksInfo(allFrontiers.map(f => f.frontier));

    let walletBalance = new BigNumber(0);
    let walletPending = new BigNumber(0);

    for (const accountID in accounts.balances) {
      if (!accounts.balances.hasOwnProperty(accountID)) continue;
      // Find the account, update it
      const walletAccount = this.wallet.accounts.find(a => a.id == accountID);
      if (!walletAccount) continue;
      walletAccount.balance = new BigNumber(accounts.balances[accountID].balance);
      walletAccount.pending = new BigNumber(accounts.balances[accountID].pending);

      walletAccount.balanceRaw = new BigNumber(walletAccount.balance).mod(this.banoshi);
      walletAccount.pendingRaw = new BigNumber(walletAccount.pending).mod(this.banoshi);

      walletAccount.balanceFiat = this.util.banano.rawToBan(walletAccount.balance).times(fiatPrice).toNumber();
      walletAccount.pendingFiat = this.util.banano.rawToBan(walletAccount.pending).times(fiatPrice).toNumber();

      walletAccount.frontier = frontiers.frontiers[accountID] || null;

      // Look at the accounts latest block to determine if they are using state blocks
      // if (walletAccount.frontier && frontierBlocks.blocks[walletAccount.frontier]) {
      //   const frontierBlock = frontierBlocks.blocks[walletAccount.frontier];
      //   const frontierBlockData = JSON.parse(frontierBlock.contents);
      //   if (frontierBlockData.type === 'state') {
      //     walletAccount.useStateBlocks = true;
      //   }
      // }

      walletBalance = walletBalance.plus(walletAccount.balance);
      walletPending = walletPending.plus(walletAccount.pending);
    }

    // Make sure any frontiers are in the work pool
    // If they have no frontier, we want to use their pub key?
    const hashes = this.wallet.accounts.map(account => account.frontier || this.util.account.getAccountPublicKey(account.id));
    hashes.forEach(hash => this.workPool.addWorkToCache(hash));

    this.wallet.balance = walletBalance;
    this.wallet.pending = walletPending;

    this.wallet.balanceRaw = new BigNumber(walletBalance).mod(this.banoshi);
    this.wallet.pendingRaw = new BigNumber(walletPending).mod(this.banoshi);

    this.wallet.balanceFiat = this.util.banano.rawToBan(walletBalance).times(fiatPrice).toNumber();
    this.wallet.pendingFiat = this.util.banano.rawToBan(walletPending).times(fiatPrice).toNumber();

    // If there is a pending balance, search for the actual pending transactions
    if (reloadPending && walletPending.gt(0)) {
      await this.loadPendingBlocksForWallet();
    }
  }



  async loadWalletAccount(accountIndex, accountID) {
    let index = accountIndex;
    const addressBookName = this.addressBook.getAccountName(accountID);

    const newAccount: WalletAccount = {
      id: accountID,
      frontier: null,
      secret: null,
      keyPair: null,
      balance: new BigNumber(0),
      pending: new BigNumber(0),
      balanceRaw: new BigNumber(0),
      pendingRaw: new BigNumber(0),
      balanceFiat: 0,
      pendingFiat: 0,
      index: index,
      addressBookName,
    };

    this.wallet.accounts.push(newAccount);
    this.websocket.subscribeAccounts([accountID]);

    return newAccount;
  }

  async addWalletAccount(accountIndex: number|null = null, reloadBalances: boolean = true) {
    // if (!this.wallet.seedBytes) return;
    let index = accountIndex;
    if (index === null) {
      index = 0; // Use the existing number, then increment it

      // Make sure the index is not being used (ie. if you delete acct 3/5, then press add twice, it goes 3, 6, 7)
      while (this.wallet.accounts.find(a => a.index === index)) index++;
    }

    let newAccount: WalletAccount|null;

    if (this.wallet.type === 'privateKey') {
      throw new Error(`Cannot add another account in private key mode`);
    } else if (this.wallet.type === 'seed') {
      newAccount = await this.createSeedAccount(index);
    } else if (this.wallet.type === 'ledger') {
      try {
        console.log(`Creating ledger account at index: `, index);
        newAccount = await this.createLedgerAccount(index);
      } catch (err) {
        // this.notifications.sendWarning(`Unable to load account from ledger.  Make sure it is connected`);
        throw err;
      }

    }

    this.wallet.accounts.push(newAccount);

    // Set new accountsIndex - used when importing wallets.  Only count from 0, won't include custom added ones
    let nextIndex = 0;
    while (this.wallet.accounts.find(a => a.index === nextIndex)) nextIndex++;
    this.wallet.accountsIndex = nextIndex;

    if (reloadBalances) await this.reloadBalances();

    this.websocket.subscribeAccounts([newAccount.id]);

    this.saveWalletExport();

    return newAccount;
  }

  async removeWalletAccount(accountID: string) {
    const walletAccount = this.getWalletAccount(accountID);
    if (!walletAccount) throw new Error(`Account is not in wallet`);

    const walletAccountIndex = this.wallet.accounts.findIndex(a => a.id === accountID);
    if (walletAccountIndex === -1) throw new Error(`Account is not in wallet`);

    this.wallet.accounts.splice(walletAccountIndex, 1);

    // Reset the account index if this account is lower than the current index
    if (walletAccount.index < this.wallet.accountsIndex) {
      this.wallet.accountsIndex = walletAccount.index;
    }

    this.websocket.unsubscribeAccounts([accountID]);

    // Reload the balances, save new wallet state
    await this.reloadBalances();
    this.saveWalletExport();

    return true;
  }

  addPendingBlock(accountID, blockHash, amount) {
    if (this.successfulBlocks.indexOf(blockHash) !== -1) return; // Already successful with this block
    const existingHash = this.pendingBlocks.find(b => b.hash == blockHash);
    if (existingHash) return; // Already added

    this.pendingBlocks.push({ account: accountID, hash: blockHash, amount: amount });
  }

  async loadPendingBlocksForWallet() {
    if (!this.wallet.accounts.length) return;
    const pending = await this.api.accountsPending(this.wallet.accounts.map(a => a.id));
    if (!pending || !pending.blocks) return;

    for (let account in pending.blocks) {
      if (!pending.blocks.hasOwnProperty(account)) continue;
      for (let block in pending.blocks[account]) {
        if (!pending.blocks[account].hasOwnProperty(block)) continue;

        this.addPendingBlock(account, block, pending.blocks[account][block].amount);
      }
    }

    // Now, only if we have results, do a unique on the account names, and run account info on all of them?
    if (this.pendingBlocks.length) {
      this.processPendingBlocks();
    }
  }

  async processPendingBlocks() {
    if (this.processingPending || this.wallet.locked || !this.pendingBlocks.length) return;

    this.processingPending = true;

    const nextBlock = this.pendingBlocks[0];
    if (this.successfulBlocks.find(b => b.hash == nextBlock.hash)) {
      return setTimeout(() => this.processPendingBlocks(), 1500); // Block has already been processed
    }
    const walletAccount = this.getWalletAccount(nextBlock.account);
    if (!walletAccount) return; // Dispose of the block, no matching account

    const newHash = await this.bananoBlock.generateReceive(walletAccount, nextBlock.hash, this.isLedgerWallet());
    if (newHash) {
      if (this.successfulBlocks.length >= 15) this.successfulBlocks.shift();
      this.successfulBlocks.push(nextBlock.hash);

      const receiveAmount = this.util.banano.rawToBan(nextBlock.amount);
      this.notifications.sendSuccess(`Successfully received ${receiveAmount.isZero() ? '' : receiveAmount.toFixed(2)} Banano!`);

      // await this.promiseSleep(500); // Give the node a chance to make sure its ready to reload all?
      await this.reloadBalances();
    } else {
      if (this.isLedgerWallet()) {
        return null; // Denied to receive, stop processing
      }
      return this.notifications.sendError(`There was a problem performing the receive transaction, try manually!`);
    }

    this.pendingBlocks.shift(); // Remove it after processing, to prevent attempting to receive duplicated messages
    this.processingPending = false;

    setTimeout(() => this.processPendingBlocks(), 1500);
  }

  saveWalletExport() {
    const exportData = this.generateWalletExport();

    switch (this.appSettings.settings.walletStore) {
      case 'none':
        this.removeWalletData();
        break;
      default:
      case 'localStorage':
        localStorage.setItem(this.storeKey, JSON.stringify(exportData));
        break;
    }
  }

  removeWalletData() {
    localStorage.removeItem(this.storeKey);
  }

  generateWalletExport() {
    let data: any = {
      type: this.wallet.type,
      accounts: this.wallet.accounts.map(a => ({ id: a.id, index: a.index })),
      accountsIndex: this.wallet.accountsIndex,
    };

    if (this.wallet.type === 'ledger') {
    }

    if (this.wallet.type === 'seed') {
      // Forcefully encrypt the seed so an unlocked wallet is never saved
      if (!this.wallet.locked) {
        const encryptedSeed = CryptoJS.AES.encrypt(this.wallet.seed, this.wallet.password || '');
        data.seed = encryptedSeed.toString();
      } else {
        data.seed = this.wallet.seed;
      }
      data.locked = this.wallet.locked;
    }

    return data;
  }

}
