/*
    The MIT License (MIT)

    Copyright 2017 - 2018, Alchemy Limited, LLC.

    Permission is hereby granted, free of charge, to any person obtaining
    a copy of this software and associated documentation files (the
    "Software"), to deal in the Software without restriction, including
    without limitation the rights to use, copy, modify, merge, publish,
    distribute, sublicense, and/or sell copies of the Software, and to
    permit persons to whom the Software is furnished to do so, subject to
    the following conditions:

    The above copyright notice and this permission notice shall be included
    in all copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
    OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
    MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
    IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
    CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
    TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
    SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

const assert = require('chai').assert

const AutonomousConverter = artifacts.require('AutonomousConverter')
const Auctions = artifacts.require('Auctions')
const MTNToken = artifacts.require('MTNToken')
const Proceeds = artifacts.require('Proceeds')
const SmartToken = artifacts.require('SmartToken')

contract('Subscriptions', accounts => {
  let mtnToken, autonomousConverter, auctions, proceeds, smartToken
  const OWNER = accounts[0]
  const FOUNDER = accounts[1]
  const SUBSCRIBERS = [accounts[2], accounts[4], accounts[6]]
  const SPENDERS = [accounts[3], accounts[5], accounts[7]]
  const PAY_PER_WEEK = 1e10

  const DAYS_IN_WEEK = 7
  const SECS_IN_DAY = 86400
  const TIME_DELTA = 60 // in seconds, to keep subscription startTime one minute ahead of block.timestamp
  const timeTravel = function (time) {
    return new Promise((resolve, reject) => {
      web3.currentProvider.sendAsync({
        jsonrpc: '2.0',
        method: 'evm_increaseTime',
        params: [time + TIME_DELTA],
        id: new Date().getTime()
      }, (err, result) => {
        if (err) { return reject(err) }
        return resolve(result)
      })
    })
  }

  const mineBlock = function () {
    return new Promise((resolve, reject) => {
      web3.currentProvider.sendAsync({
        jsonrpc: '2.0',
        method: 'evm_mine'
      }, (err, result) => {
        if (err) { return reject(err) }
        return resolve(result)
      })
    })
  }

  function getCurrentBlockTime () {
    var defaultBlock = web3.eth.defaultBlock
    return web3.eth.getBlock(defaultBlock).timestamp + TIME_DELTA
  }

  beforeEach(async () => {
    autonomousConverter = await AutonomousConverter.new({from: OWNER})
    auctions = await Auctions.new({from: OWNER})
    proceeds = await Proceeds.new({from: OWNER})

    const founders = []
    founders.push(OWNER + '0000D3C214DE7193CD4E0000')
    founders.push(FOUNDER + '0000D3C214DE7193CD4E0000')

    const MTN_INITIAL_SUPPLY = 0
    const ST_INITIAL_SUPPLY = 10e6
    const DECMULT = 10 ** 18
    const MINIMUM_PRICE = 1000
    const STARTING_PRICE = 1
    const TIME_SCALE = 1
    let timeInSeconds = new Date().getTime() / 1000
    const INITIAL_AUCTION_END_TIME = 7 * 24 * 60 * 60 // 7 days in seconds
    var START_TIME = (Math.floor(timeInSeconds / 60) * 60) - INITIAL_AUCTION_END_TIME - 120

    mtnToken = await MTNToken.new(autonomousConverter.address, auctions.address, MTN_INITIAL_SUPPLY, DECMULT, {from: OWNER})
    smartToken = await SmartToken.new(autonomousConverter.address, autonomousConverter.address, ST_INITIAL_SUPPLY, {from: OWNER})
    await autonomousConverter.init(mtnToken.address, smartToken.address, auctions.address, { from: OWNER, value: web3.toWei(1, 'ether') })
    await proceeds.initProceeds(autonomousConverter.address, auctions.address, {from: OWNER})
    await auctions.mintInitialSupply(founders, mtnToken.address, proceeds.address, autonomousConverter.address, {from: OWNER})
    await auctions.initAuctions(START_TIME, MINIMUM_PRICE, STARTING_PRICE, TIME_SCALE, {from: OWNER})
    await mtnToken.enableMTNTransfers()
  })

  describe('Time travel', () => {
    it('Consistent Weekly Payments for a year', () => {
      return new Promise(async (resolve, reject) => {
        // subscribe users
        const startTime = getCurrentBlockTime()
        for (let i = 0; i < SUBSCRIBERS.length; i++) {
          await autonomousConverter.convertEthToMtn(1, { from: SUBSCRIBERS[i], value: 2e18 })
          const tx = await mtnToken.subscribe(startTime, PAY_PER_WEEK, SPENDERS[i], {from: SUBSCRIBERS[i]})
          assert.equal(tx.logs.length, 1, 'incorrect number of logs')
          const log = tx.logs[0]
          assert.equal(log.event, 'LogSubscription', 'LogSubscription was not found')
          assert.equal(log.args.subscriber, SUBSCRIBERS[i], 'Subscriber is wrong')
          assert.equal(log.args.subscribesTo, SPENDERS[i], 'SubscribesTo is wrong')
        }

        for (let w = 0; w < 52; w++) {
          // advance a week
          await timeTravel(SECS_IN_DAY * DAYS_IN_WEEK)
          await mineBlock()

          let n = await mtnToken.multiSubWithdrawFor.call(SUBSCRIBERS, SPENDERS, {from: OWNER})
          assert.equal(n, SPENDERS.length, 'Return value was incorrect')
          let tx = await mtnToken.multiSubWithdrawFor(SUBSCRIBERS, SPENDERS, {from: OWNER})
          assert.equal(tx.logs.length, SPENDERS.length, 'Not all payments were processed')

          for (let i = 0; i < tx.logs.length; i++) {
            const log = tx.logs[i]
            assert.equal(log.event, 'Transfer', 'Transfer event was not found')
            assert.equal(log.args._from, SUBSCRIBERS[i], 'From is wrong')
            assert.equal(log.args._to, SPENDERS[i], 'To is wrong')
            assert.equal(log.args._value.toNumber(), PAY_PER_WEEK, 'Transfer amount is wrong')
          }
        }

        resolve()
      })
    })

    it('Consistent Weekly Payments for a year with a future start date', () => {
      return new Promise(async (resolve, reject) => {
        // subscribe users
        const startTime = getCurrentBlockTime()
        var balance
        for (let i = 0; i < (SUBSCRIBERS.length); i++) {
          await autonomousConverter.convertEthToMtn(1, { from: SUBSCRIBERS[i], value: 2e18 })
          await mtnToken.subscribe(startTime + (i * SECS_IN_DAY * DAYS_IN_WEEK), PAY_PER_WEEK, SPENDERS[i], {from: SUBSCRIBERS[i]})
        }

        for (let w = 0; w < 52; w++) {
          // advance a week
          await timeTravel(SECS_IN_DAY * DAYS_IN_WEEK)
          await mineBlock()

          let tx = await mtnToken.multiSubWithdrawFor(SUBSCRIBERS, SPENDERS, {from: OWNER})
          if (w === 0) {
            assert.equal(tx.logs.length, 1, 'Not all payments were processed')
          } else if (w === 1) {
            assert.equal(tx.logs.length, 2, 'Not all payments were processed')
          } else {
            assert.equal(tx.logs.length, SPENDERS.length, 'Not all payments were processed')
          }
          let expectedBalance
          for (let i = 0; i < SPENDERS.length; i++) {
            balance = await mtnToken.balanceOf(SPENDERS[i])
            expectedBalance = PAY_PER_WEEK * (w - i + 1)
            if (expectedBalance < 0) {
              expectedBalance = 0
            }
            assert.equal(expectedBalance, balance.valueOf(), 'payment not transferred to ' + SPENDERS[i] + ' for week ' + w)
          }
        }
        resolve()
      })
    })

    it('Consistent Payments every other week for two years', () => {
      return new Promise(async (resolve, reject) => {
        // subscribe users, time offset starts one year ahead
        const startTime = getCurrentBlockTime()
        for (let i = 0; i < SUBSCRIBERS.length; i++) {
          await autonomousConverter.convertEthToMtn(1, { from: SUBSCRIBERS[i], value: 2e18 })
          await mtnToken.subscribe(startTime, PAY_PER_WEEK, SPENDERS[i], {from: SUBSCRIBERS[i]})
        }

        for (let w = 0; w < 104; w++) {
          // advance a week
          await timeTravel(SECS_IN_DAY * DAYS_IN_WEEK)
          await mineBlock()

          if (w % 2 !== 0) {
            let tx = await mtnToken.multiSubWithdrawFor(SUBSCRIBERS, SPENDERS, {from: OWNER})
            assert.equal(tx.logs.length, SPENDERS.length, 'Not all payments were processed')

            for (let i = 0; i < tx.logs.length; i++) {
              const log = tx.logs[i]
              assert.equal(log.event, 'Transfer', 'Transfer event was not found')
              assert.equal(log.args._from, SUBSCRIBERS[i], 'From is wrong')
              assert.equal(log.args._to, SPENDERS[i], 'To is wrong')
              assert.equal(log.args._value.toNumber(), PAY_PER_WEEK * 2, 'Transfer amount is wrong')
            }
          }
        }

        resolve()
      })
    })

    it('One spender will withdraw on their own for a year', () => {
      return new Promise(async (resolve, reject) => {
        // subscribe users, time offset is 3 years ahead
        const startTime = getCurrentBlockTime()
        for (let i = 0; i < SUBSCRIBERS.length; i++) {
          await autonomousConverter.convertEthToMtn(1, { from: SUBSCRIBERS[i], value: 2e18 })
          await mtnToken.subscribe(startTime, PAY_PER_WEEK, SPENDERS[i], {from: SUBSCRIBERS[i]})
        }

        for (let w = 0; w < 52; w++) {
          // advance a week
          await timeTravel(SECS_IN_DAY * DAYS_IN_WEEK)
          await mineBlock()

          // one spender withdraws on their own
          const diligentSpender = SPENDERS[0]
          const luckySub = SUBSCRIBERS[0]
          const txSpender = await mtnToken.subWithdraw(luckySub, {from: diligentSpender})
          assert.equal(txSpender.logs.length, 1, 'Tansfer was not triggered')
          const firstLog = txSpender.logs[0]
          assert.equal(firstLog.event, 'Transfer', 'Transfer event was not found')
          assert.equal(firstLog.args._from, luckySub, 'From is wrong')
          assert.equal(firstLog.args._to, diligentSpender, 'To is wrong')
          assert.equal(firstLog.args._value.toNumber(), PAY_PER_WEEK, 'Transfer amount is wrong')

          let tx = await mtnToken.multiSubWithdrawFor(SUBSCRIBERS, SPENDERS, {from: OWNER})
          assert.equal(tx.logs.length, SPENDERS.length - 1, 'Not all payments were processed')

          for (let i = 0; i < tx.logs.length; i++) {
            const log = tx.logs[i]
            const subOff = i + 1 // offset for first spender
            assert.equal(log.event, 'Transfer', 'Transfer event was not found')
            assert.equal(log.args._from, SUBSCRIBERS[subOff], 'From is wrong')
            assert.equal(log.args._to, SPENDERS[subOff], 'To is wrong')
            assert.equal(log.args._value.toNumber(), PAY_PER_WEEK, 'Transfer amount is wrong')
          }
        }
        resolve()
      })
    })

    it('Should verify subWithdraw function when subscription started', () => {
      return new Promise(async (resolve, reject) => {
        const spender = accounts[9]
        const startTime = getCurrentBlockTime()

        await autonomousConverter.convertEthToMtn(1, { from: OWNER, value: 2e18 })
        await mtnToken.subscribe(startTime, PAY_PER_WEEK, spender, {from: OWNER})

        await timeTravel(SECS_IN_DAY * DAYS_IN_WEEK)
        await mineBlock()

        const balanceBefore = await mtnToken.balanceOf(spender)
        await mtnToken.subWithdraw(OWNER, {from: spender})
        const balanceAfter = await mtnToken.balanceOf(spender)
        assert.equal(balanceAfter.sub(balanceBefore), PAY_PER_WEEK, 'Subscription withdraw failed')

        resolve()
      })
    })

    it('Should verify subWithdraw function when subscription started 12 months ago', () => {
      return new Promise(async (resolve, reject) => {
        const spender = accounts[9]
        const allowance = PAY_PER_WEEK * 52 // 52 weeks in 12 months

        const startTime = getCurrentBlockTime()

        await autonomousConverter.convertEthToMtn(1, { from: OWNER, value: 2e18 })
        await mtnToken.subscribe(startTime, PAY_PER_WEEK, spender, {from: OWNER})

        await timeTravel(SECS_IN_DAY * DAYS_IN_WEEK * 52)
        await mineBlock()

        const balanceBefore = await mtnToken.balanceOf(spender)
        assert.equal(balanceBefore, 0, 'balance of spender is not zero')

        await mtnToken.subWithdraw(OWNER, {from: spender})
        const balanceAfter = await mtnToken.balanceOf(spender)
        assert.equal(balanceAfter, allowance, 'Subscription withdraw failed')

        resolve()
      })
    })

    it('Should verify multiSubWithdraw function', () => {
      return new Promise(async (resolve, reject) => {
        const spender = accounts[9]

        const allowance = PAY_PER_WEEK * SUBSCRIBERS.length

        const startTime = getCurrentBlockTime()

        for (let i = 0; i < SUBSCRIBERS.length; i++) {
          await autonomousConverter.convertEthToMtn(1, { from: SUBSCRIBERS[i], value: 2e18 })
          await mtnToken.subscribe(startTime, PAY_PER_WEEK, spender, {from: SUBSCRIBERS[i]})
        }

        // await autonomousConverter.convertEthToMtn(1, { from: subscriber, value: 2e18 })
        // await mtnToken.transfer(otherSubscriber, 1e16, {from: subscriber})
        //
        // await mtnToken.subscribe(startTime, PAY_PER_WEEK, spender, {from: subscriber})
        // await mtnToken.subscribe(startTime, PAY_PER_WEEK, spender, {from: otherSubscriber})

        await timeTravel(SECS_IN_DAY * DAYS_IN_WEEK)
        await mineBlock()

        const balanceBefore = await mtnToken.balanceOf(spender)
        assert.equal(balanceBefore, 0, 'balance of spender is not zero')

        await mtnToken.multiSubWithdraw(SUBSCRIBERS, {from: spender})
        const balanceAfter = await mtnToken.balanceOf(spender)
        assert.equal(balanceAfter, allowance, 'Subscription multiSubWithdraw failed from OWNER and other_subscriber')

        resolve()
      })
    })

    it('Should verify that no underflow in multiSubWithdrawFor function', () => {
      return new Promise(async (resolve, reject) => {
        const spenders = [accounts[3], accounts[5]]
        const subscribers = [accounts[4], accounts[6]]
        const payPerWeek = 1e17

        const startTime = getCurrentBlockTime()

        await autonomousConverter.convertEthToMtn(1, { from: subscribers[1], value: 2e18 })
        await mtnToken.transfer(subscribers[0], 1e16, {from: subscribers[1]})

        for (let i = 0; i < subscribers.length; i++) {
          await mtnToken.subscribe(startTime, payPerWeek, spenders[i], {from: subscribers[i]})
          assert.equal(await mtnToken.balanceOf(spenders[i]), 0, 'balance is not zero for spender at ' + i)
        }

        await timeTravel(SECS_IN_DAY * DAYS_IN_WEEK)
        await mineBlock()

        const nTransfers = await mtnToken.multiSubWithdrawFor.call(subscribers, spenders)
        assert.equal(nTransfers, subscribers.length - 1, 'Too many transfers accepted, possible underflow')

        const result = await mtnToken.multiSubWithdrawFor(subscribers, spenders)
        assert.equal(result.logs.length, subscribers.length - 1, 'Underflow happened in multiSubWithdrawFor')

        assert.equal(await mtnToken.balanceOf(spenders[0]), 0, 'Allowance is more than available balance, subscription payment should be 0')
        assert.equal(await mtnToken.balanceOf(spenders[1]), payPerWeek, 'Subscription payment is failed from accounts[6]')

        resolve()
      })
    })
  })
})