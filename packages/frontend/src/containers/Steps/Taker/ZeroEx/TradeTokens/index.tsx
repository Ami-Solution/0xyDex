import * as React from 'react';
import Faucet from '../../../../../components/Faucet';
import { Token, OrderState, BlockParamLiteral, SignedOrder, ZeroEx } from '0x.js';
import { Dictionary } from 'lodash';
import { TokenAllowance } from '../../../../App';
import * as _ from 'lodash';
import { ZeroExRelayerWebSocketChannel } from '../../../../../api/orderbook/zeroEx/webSocket';
import { Utils } from '../../../../../utils';
import { BigNumber } from 'bignumber.js';
import * as Web3 from 'web3';
import { UserActionMessageStatus } from '../../../../../components/UserActionMessage';
import { 
    TokenPair, 
    OrderbookSnapshot, 
    OrderbookUpdate, 
    TokenPairOrderbook, 
    EnrichedSignedOrder,
    EnrichedTokenPairOrderbook
} from '../../../../../types';
import { 
    DropdownProps, 
    Dropdown, 
    Button, 
    Container, 
    Form, 
    Radio, 
    TextArea, 
    Checkbox, 
    Input, 
    DropdownItemProps, 
    Grid, 
    Statistic, 
    Icon, 
    Divider, 
    Label,
    ButtonProps
} from 'semantic-ui-react';
import { OrderStateWatcher } from '0x.js/lib/src/order_watcher/order_state_watcher';
import { 
    TokenRateStatistics, 
    TokenStatistics, 
    TokenStatisticsPlaceholder 
} from '../../../../../components/TokenStatistics';

export type TradeAction = 'Buy' | 'Sell';

interface Props {
    zeroEx: ZeroEx;
    tokensWithAllowance: Dictionary<TokenAllowance>;
    zeroExProxyTokens: Token[];
    accounts: string[];
    setTransactionMessageState: (status: UserActionMessageStatus, message?: string) => void;
}

interface State {
    tradeAction: TradeAction;
    tokenQuantity: BigNumber;
    baseToken: Token | undefined;
    quoteToken: Token | undefined;
    enrichedOrderbook: EnrichedTokenPairOrderbook | undefined;
    lowerBoundExchangeRate: BigNumber;
    upperBoundExchangeRate: BigNumber;
    tokenStatisticsIsLoading: boolean;
    tokenStatisticsWarning: string[] | null;
}

export default class ZeroExTradeTokens extends React.Component<Props, State> {

    relayerWsChannel: ZeroExRelayerWebSocketChannel | null;
    orderStateWatcher: OrderStateWatcher;

    // Sets maintain insertion order
    ordersToFill: Map<string, SignedOrder>;
    
    constructor(props: Props) {
        super(props);

        this.orderStateWatcher = this.props.zeroEx.createOrderStateWatcher({
            stateLayer: BlockParamLiteral.Latest
        });

        this.state = {
            tradeAction: 'Buy',
            tokenQuantity: new BigNumber(0),
            baseToken: undefined,
            quoteToken: undefined,
            enrichedOrderbook: undefined,
            lowerBoundExchangeRate: new BigNumber(0),
            upperBoundExchangeRate: new BigNumber(0),
            tokenStatisticsWarning: null,
            tokenStatisticsIsLoading: false
        };
    }

    componentWillUnmount() {
        if (this.relayerWsChannel) {
            this.relayerWsChannel.closeConnection();
        }
        try {
            this.orderStateWatcher.unsubscribe();
        } catch (e) {
            console.log('TradeTokens componentWillUnmount error: ', e.message);
        }
    }

    fetchProxyTokenList = async () => {
        const tokens = await this.props.zeroEx.tokenRegistry.getTokensAsync();
    }

    handleTradeActionChange = async (e, { value }) => {
        await this.setState({ tradeAction: value });
        this.onPropertyChanged();
    }

    handleTokenQuantityChange = async (e, { value }) => {
        const shouldResubscribeToRelayer = this.state.tokenQuantity.equals(0);
        if (value) {
            try {
                await this.setState( { tokenQuantity: new BigNumber(value) } );
                if (shouldResubscribeToRelayer) {
                    await this.onPropertyChanged();
                } else {
                    await this.calculateRateRange();
                }
            } catch( e ) {
                console.log(e);
            }
        }
    }

    handleBaseTokenDropDownItemSelected = async (e, data: DropdownProps) => {
        const itemProp = _.find(data.options, {value: data.value}) as DropdownItemProps;
        await this.setState({ baseToken: itemProp.token });
        await this.onPropertyChanged();
    }

    handleQuoteTokenDropDownItemSelected = async (e, data: DropdownProps) => {
        const itemProp = _.find(data.options, {value: data.value}) as DropdownItemProps;
        await this.setState({ quoteToken: itemProp.token });
        await this.onPropertyChanged();
    }

    onPropertyChanged = async () => {
        let baseToken = this.state.baseToken;
        let quoteToken = this.state.quoteToken;
        let tradeAction = this.state.tradeAction;
        
        if (baseToken && quoteToken && this.state.tokenQuantity.greaterThan(0)) {
            baseToken = baseToken as Token;
            quoteToken = quoteToken as Token;

            let tokenPair: TokenPair = tradeAction === 'Buy' ? 
            {
                base: baseToken,
                quote: quoteToken
            } : {
                base: quoteToken,
                quote: baseToken
            };

            if (this.relayerWsChannel) {
                await this.setState({ tokenStatisticsIsLoading: true });
                await this.relayerWsChannel.initialiseConnection();
                await this.relayerWsChannel.subscribe(tokenPair);
            } 

        } else {
            this.ordersToFill = new Map();
        }

    }

    onRelayerSnapshot = async (snapshot: OrderbookSnapshot, tokenPair: TokenPair) => {
        const tokenPairOrderbook = Utils.TokenPairOrderbookFromJSON(snapshot);
        const takerAddress = this.props.accounts[0];

        // Log number of bids and asks currently in the orderbook
        const numberOfBids = tokenPairOrderbook.bids.length;
        const numberOfAsks = tokenPairOrderbook.asks.length;
        console.log(`SNAPSHOT: ${numberOfBids} bids & ${numberOfAsks} asks`);

        // Filter orders which takerAddress == order.maker
        tokenPairOrderbook.asks = tokenPairOrderbook.asks.filter((order: SignedOrder) => {
            return order.maker !== takerAddress;
        });

        tokenPairOrderbook.bids = tokenPairOrderbook.bids.filter((order: SignedOrder) => {
            return order.maker !== takerAddress;
        });

        // Enrich
        const enrichedOrderbook = await this.validateAndEnrichOrderbook(tokenPairOrderbook);

        // Sort bids and asks in order of best rates
        enrichedOrderbook.bids = enrichedOrderbook.bids.sort(this.sortEnrichedBids);
        enrichedOrderbook.asks = enrichedOrderbook.asks.sort(this.sortEnrichedAsks);

        this.setState({ enrichedOrderbook }, this.calculateRateRange);
        await this.setState({ tokenStatisticsIsLoading: false });

    }

    // Sort in ascending order of makerTokenAmount / takerTokenAmount
    sortEnrichedBids = (a: EnrichedSignedOrder, b: EnrichedSignedOrder) => {
        const orderRateA = a.remainingMakerTokenAmount.dividedBy(a.remainingTakerTokenAmount);
        const orderRateB = b.remainingMakerTokenAmount.dividedBy(b.remainingTakerTokenAmount);
        return orderRateA.comparedTo(orderRateB);
    }

    // Sort in descending order of makerTokenAmount / takerTokenAmount
    sortEnrichedAsks = (a: EnrichedSignedOrder, b: EnrichedSignedOrder) => {
        const orderRateA = a.remainingMakerTokenAmount.dividedBy(a.remainingTakerTokenAmount);
        const orderRateB = b.remainingMakerTokenAmount.dividedBy(b.remainingTakerTokenAmount);
        return orderRateB.comparedTo(orderRateA);
    }

    onRelayerUpdate = async (update: OrderbookUpdate, tokenPair: TokenPair) => {
        const zeroEx = this.props.zeroEx;
        const enrichedOrderbook = Object.assign({}, this.state.enrichedOrderbook) as EnrichedTokenPairOrderbook;
        const order: SignedOrder = Utils.SignedOrderfromJSON(update);
        
        // Log order hash
        const orderHash = ZeroEx.getOrderHashHex(order);
        console.log(`NEW ORDER: ${orderHash}`);
        console.log('ask array length', JSON.stringify(this.state.enrichedOrderbook));

        // Return if order already exists in orderbook
        for (let x = 0; x < enrichedOrderbook.asks.length; x++) {
            if (ZeroEx.getOrderHashHex(enrichedOrderbook.asks[x].signedOrder) === ZeroEx.getOrderHashHex(order)) {
                console.log('REPEAT ASK IGNORING');
                return;
            }
        }

        for (let x = 0; x < enrichedOrderbook.bids.length; x++) {
            if (ZeroEx.getOrderHashHex(enrichedOrderbook.bids[x].signedOrder) === ZeroEx.getOrderHashHex(order)) {
                console.log('REPEAT BID IGNORING');
                return;
            }
        }

        // Enrich Order
        this.validateAndEnrichSignedOrder(order)
            .then((enrichedOrder: EnrichedSignedOrder) => {    
                // Ask - Taker buys base token, Maker buys quote token
                if (order.makerTokenAddress === tokenPair.base.address) {
                    // TODO: Find more efficient method of adding new asks in sorted fashion
                    enrichedOrderbook.asks.push(enrichedOrder);
                    enrichedOrderbook.asks.sort(this.sortEnrichedAsks);
                }

                // Bids - Maker buys base token, Taker buys quote token
                if (order.makerTokenAddress === tokenPair.quote.address) {
                    // TODO: Find more efficient method of adding new bids in sorted fashion
                    enrichedOrderbook.bids.push(enrichedOrder);
                    enrichedOrderbook.bids.sort(this.sortEnrichedBids);
                }
                
                this.setState({
                    enrichedOrderbook
                });

                return this.calculateRateRange();
            })
            .catch(err => {
                console.log(`Invalid Signed Order Update ${JSON.stringify(order)} with Error: ${err.message}`)
            }
        );
    }

    async validateAndEnrichOrderbook(orderbook: TokenPairOrderbook): Promise<EnrichedTokenPairOrderbook> {
        let enrichedBids: EnrichedSignedOrder[] = [];
        let enrichedAsks: EnrichedSignedOrder[] = [];

        for (let x = 0; x < orderbook.asks.length; x++) {
            let order: SignedOrder = orderbook.asks[x];
            try {
                let enrichedOrder: EnrichedSignedOrder = await this.validateAndEnrichSignedOrder(order);
                enrichedAsks.push(enrichedOrder);
            } catch(e) {
                console.log(`Invalid Order Error ${e.message}`);
            }
        }

        for (let x = 0; x < orderbook.bids.length; x++) {
            let order: SignedOrder = orderbook.bids[x];
            try {
                let enrichedOrder: EnrichedSignedOrder = await this.validateAndEnrichSignedOrder(order);
                enrichedBids.push(enrichedOrder);
            } catch(e) {
                console.log(`Invalid Order Error ${e.message}`);
            }
        }

        const enrichedTokenPairOrderbook: EnrichedTokenPairOrderbook = {
            bids: enrichedBids,
            asks: enrichedAsks
        };

        console.log(`ENRICHED: ${enrichedBids.length} bids & ${enrichedAsks.length} asks`);

        return enrichedTokenPairOrderbook;
    }

    validateAndEnrichSignedOrder(signedOrder: SignedOrder): Promise<EnrichedSignedOrder> {
        const zeroEx = this.props.zeroEx;

        let orderHashHex: string = ZeroEx.getOrderHashHex(signedOrder);
        
        const enrichedOrder: EnrichedSignedOrder = {
            signedOrder: signedOrder,
            remainingMakerTokenAmount: signedOrder.makerTokenAmount,
            remainingTakerTokenAmount: signedOrder.takerTokenAmount
        };

        let remainingFillableTakerAmount = new BigNumber(0);

        return zeroEx
            .exchange
            .getCancelledTakerAmountAsync(orderHashHex)
            .then((cancelledTakerAmount: BigNumber) => {
                remainingFillableTakerAmount = remainingFillableTakerAmount.add(cancelledTakerAmount);
                return zeroEx.exchange.getFilledTakerAmountAsync(orderHashHex);
            })
            .then((filledTakerAmount: BigNumber) => {
                remainingFillableTakerAmount = remainingFillableTakerAmount.add(filledTakerAmount);
                
                if (!remainingFillableTakerAmount.lessThan(signedOrder.takerTokenAmount)) {
                    throw (
                        `Unfillable Order Error! Order has no fillable tokens remaining:\n
                        ${JSON.stringify(signedOrder)}`
                    );
                }

                const rate = enrichedOrder.signedOrder.makerTokenAmount.div(
                    enrichedOrder.signedOrder.takerTokenAmount
                );
                
                enrichedOrder.remainingTakerTokenAmount = enrichedOrder.remainingTakerTokenAmount.minus(
                    remainingFillableTakerAmount
                );

                enrichedOrder.remainingMakerTokenAmount = enrichedOrder.remainingMakerTokenAmount.minus(
                    remainingFillableTakerAmount.mul(rate)
                );

                return enrichedOrder;
            })
            .catch(err => {
                throw err;
            }
        );          
    }

    updateEnrichedOrderbook = async (
        orderHash: string, 
        remMakerTokenAmout: BigNumber,
        remTakerTokenAmount: BigNumber
    ): Promise<boolean> => {
        if (this.state.enrichedOrderbook) {
            const enrichedOrderbook = Object.assign({}, this.state.enrichedOrderbook);

            let enrichedOrder = enrichedOrderbook.asks.find(order => {
                return ZeroEx.getOrderHashHex(order.signedOrder) === orderHash;
            });
    
            enrichedOrder = enrichedOrder || enrichedOrderbook.bids.find(order => {
                return ZeroEx.getOrderHashHex(order.signedOrder) === orderHash;
            });

            // We don't want to return undefined hence the need for this check
            if (!enrichedOrder) {
                return false;
            }

            enrichedOrder.remainingMakerTokenAmount = remMakerTokenAmout;
            enrichedOrder.remainingTakerTokenAmount = remTakerTokenAmount;

            await this.setState({ enrichedOrderbook });

            return true;
        }
        return false;
    }

    removeOrderFromEnrichedOrderbook = async (
        orderHash: string, 
    ): Promise<void> => {
        if (this.state.enrichedOrderbook) {
            const enrichedOrderbook = Object.assign({}, this.state.enrichedOrderbook);

            enrichedOrderbook.asks.filter(order => {
                return ZeroEx.getOrderHashHex(order.signedOrder) !== orderHash;
            });
    
            enrichedOrderbook.bids.filter(order => {
                return ZeroEx.getOrderHashHex(order.signedOrder) !== orderHash;
            });

            await this.setState({ enrichedOrderbook });
        }
    }

    // TODO: Implement special logic for Order fills and cancellations - Currently maker/taker amount is set to 0
    onOrderWatcherEvent = async (err: Error | null, orderState?: OrderState) => {
        if (orderState && orderState.isValid) {
            const orderRelevantState = orderState.orderRelevantState;
            
            this.updateEnrichedOrderbook(
                orderState.orderHash,
                orderRelevantState.remainingFillableMakerTokenAmount,
                orderRelevantState.remainingFillableTakerTokenAmount
            )
            .then((success: boolean) => {
                if (!success) {
                    return this.orderStateWatcher.removeOrder(orderState.orderHash);
                } else {
                    return this.calculateRateRange();
                }
            });
        } else if (orderState && !orderState.isValid) {
            // Invalid OrderState or non existent OrderState with Error
            this.orderStateWatcher.removeOrder(orderState.orderHash);

            // Remove order && recalculate rates
            this.removeOrderFromEnrichedOrderbook(orderState.orderHash)
                .then(this.calculateRateRange);            
        }
    }

    calculateRateRange = async () => {
        let baseToken = this.state.baseToken;
        let quoteToken = this.state.quoteToken;
        const tradeAction = this.state.tradeAction;
        const tokenQuantity = this.state.tokenQuantity;
        const enrichedOrderbook = this.state.enrichedOrderbook;

        let minExchangeRate;
        let maxExchangeRate;

        // (Ask, Buy) - Taker buys base token, Maker sells base token
        if (baseToken && 
            quoteToken && 
            tokenQuantity.greaterThan(0) &&
            enrichedOrderbook &&
            // App logic has been designed such that buys and sells both rely on asks
            enrichedOrderbook.asks.length > 0
        ) {
            await this.setState({
                tokenStatisticsWarning: null
            });

            const asks: EnrichedSignedOrder[] = enrichedOrderbook.asks;

            // onPropertyChanged() switches the base and quote tokens when querying
            // the orderbook for a 'sell' trade action. This allows us to only focus on
            // orderbook asks and never bids
            if (tradeAction === 'Buy') {
                baseToken = this.state.baseToken as Token;
                quoteToken = this.state.quoteToken as Token;
            } else {
                baseToken = this.state.quoteToken as Token;
                quoteToken = this.state.baseToken as Token;
            }

            let lowerBoundBaseTokenQuantity: BigNumber = new BigNumber(0);
            let lowerBoundQuoteTokenQuantity: BigNumber = new BigNumber(0);

            let upperBoundBaseTokenQuantity: BigNumber = new BigNumber(0);
            let upperBoundQuoteTokenQuantity: BigNumber = new BigNumber(0);

            // TODO: Save to state
            this.ordersToFill = new Map();

            // Calculate Lower Bound
            let i;
            for (i = 0; i < asks.length; i++) {
                const enrichedOrder: EnrichedSignedOrder = asks[i];
                if (lowerBoundBaseTokenQuantity.lessThan(tokenQuantity)) {
                    console.log(`lower bound signed order: ${JSON.stringify(enrichedOrder)}`);

                    const makerTokenAmount = ZeroEx.toUnitAmount(
                        new BigNumber(enrichedOrder.remainingMakerTokenAmount),
                        baseToken.decimals
                    );
        
                    const takerTokenAmount = ZeroEx.toUnitAmount(
                        new BigNumber(enrichedOrder.remainingTakerTokenAmount),
                        quoteToken.decimals
                    );

                    let baseTokenQuantityToFill = tokenQuantity.minus(lowerBoundBaseTokenQuantity);
                    let orderRate = takerTokenAmount.div(makerTokenAmount);
                    
                    baseTokenQuantityToFill = BigNumber.min(baseTokenQuantityToFill, makerTokenAmount);

                    lowerBoundBaseTokenQuantity = lowerBoundBaseTokenQuantity.add(baseTokenQuantityToFill);

                    let quoteTokenQuantityToFill = orderRate.mul(baseTokenQuantityToFill);
                    lowerBoundQuoteTokenQuantity = lowerBoundQuoteTokenQuantity.add(quoteTokenQuantityToFill);

                    const hashHex = ZeroEx.getOrderHashHex(enrichedOrder.signedOrder);
                    if (!this.ordersToFill.has(ZeroEx.getOrderHashHex(enrichedOrder.signedOrder))) {
                        this.ordersToFill.set(hashHex, enrichedOrder.signedOrder);
                    }
                } else {
                    break;
                }
            }

            // Display token statistics warning if not enough liquidity exists
            if (lowerBoundBaseTokenQuantity.lessThan(tokenQuantity)) {
                const msg: string[] = [`Not enough liqiduity exists for your trade requirements.`, 
                    `You can only ${tradeAction.toLowerCase()} a maximum of ` + 
                    `${lowerBoundBaseTokenQuantity} ${baseToken.symbol} tokens.`];

                await this.setState({
                    tokenStatisticsWarning: msg 
                });
                console.log('Statistics warning: ', msg);
                return;
            }

            // Calculate conservative threadshold for upper bound estimate. Currently 2x
            i = (i * 2) >= asks.length ? asks.length - 1 : (i * 2) ;

            // Calculate Upper Bound
            for (i; i >= 0; i--) {
                const enrichedOrder: EnrichedSignedOrder = asks[i];
                if ((upperBoundBaseTokenQuantity.lessThan(tokenQuantity))) {
                    
                    const makerTokenAmount = ZeroEx.toUnitAmount(
                        new BigNumber(enrichedOrder.remainingMakerTokenAmount),
                        baseToken.decimals
                    );
        
                    const takerTokenAmount = ZeroEx.toUnitAmount(
                        new BigNumber(enrichedOrder.remainingTakerTokenAmount),
                        quoteToken.decimals
                    );

                    console.log(`upper bound signed order: ${JSON.stringify(enrichedOrder)}`);
                    let baseTokenQuantityToFill = tokenQuantity.minus(upperBoundBaseTokenQuantity);
                    let orderRate = takerTokenAmount.div(makerTokenAmount);

                    baseTokenQuantityToFill = BigNumber.min(baseTokenQuantityToFill, makerTokenAmount);

                    upperBoundBaseTokenQuantity = upperBoundBaseTokenQuantity.add(baseTokenQuantityToFill);

                    let quoteTokenQuantityToFill = orderRate.mul(baseTokenQuantityToFill);
                    upperBoundQuoteTokenQuantity = upperBoundQuoteTokenQuantity.add(quoteTokenQuantityToFill);

                    const hashHex = ZeroEx.getOrderHashHex(enrichedOrder.signedOrder);
                    if (!this.ordersToFill.has(ZeroEx.getOrderHashHex(enrichedOrder.signedOrder))) {
                        this.ordersToFill.set(hashHex, enrichedOrder.signedOrder);
                    }
                } else {
                    break;
                }
            }

            await this.setState({
                lowerBoundExchangeRate: lowerBoundQuoteTokenQuantity.div(lowerBoundBaseTokenQuantity),
                upperBoundExchangeRate: upperBoundQuoteTokenQuantity.div(upperBoundBaseTokenQuantity)
            });
        } else if (baseToken && quoteToken && tokenQuantity.greaterThan(0)) {
            const msg: string[] = [`No liqiduity exists for your chosen token pair.`];
            await this.setState({ tokenStatisticsWarning: msg });
            console.log('Statistics warning: ', msg);
        }
    }

    onClickTrade = async (event: React.MouseEvent<HTMLButtonElement>, data: ButtonProps) => {
        const takerAddress = this.props.accounts[0];
        const baseToken = this.state.baseToken as Token;
        const quoteToken = this.state.quoteToken as Token;
        const handleTxMsg = this.props.setTransactionMessageState;
        
        const fillQuantity = ZeroEx.toBaseUnitAmount(
            this.state.tokenQuantity,
            baseToken.decimals
        );

        if (this.ordersToFill.size > 0 
            && baseToken 
            && quoteToken 
            && fillQuantity.greaterThan(0)
        ) {
            handleTxMsg('LOADING');
            
            const orderArray: SignedOrder[] = Array.from(this.ordersToFill.values());
            
            console.log('signed orders to fill:' + JSON.stringify(orderArray));
            console.log('Order fill amount:' + fillQuantity);
            
            try {
                const txMsg = await this.props.zeroEx.exchange.fillOrdersUpToAsync(
                    orderArray, 
                    fillQuantity, 
                    true, 
                    takerAddress
                );

                const txReceipt = await this.props.zeroEx.awaitTransactionMinedAsync(txMsg);

                handleTxMsg('TRADE_SUCCESS', txReceipt.transactionHash);
            } catch (error) {
                handleTxMsg('FAILURE', error.message);
            }
        }
    }

    render() {
        const zeroExProxyTokens: Token[] = this.props.zeroExProxyTokens;
        const tokensWithAllowance: Dictionary<TokenAllowance> = this.props.tokensWithAllowance;
        const baseToken = this.state.baseToken;
        const quoteToken = this.state.quoteToken;
        const tradeAction = this.state.tradeAction;
        const lowerBoundExchangeRate = this.state.lowerBoundExchangeRate;
        const upperBoundExchangeRate = this.state.upperBoundExchangeRate;

        const quoteTokenDropDownItems: DropdownItemProps[] = _.chain(zeroExProxyTokens)
            .filter((token: Token) => tokensWithAllowance[token.symbol])
            .map((token: Token) => {
                return {
                    key: token.symbol,
                    value: token.symbol, 
                    token: token, 
                    text: `${token.symbol}: ${token.name}`,
                };
            })
            .value();

        const baseTokenDropDownItems: DropdownItemProps[] = _.map(zeroExProxyTokens, (token: Token) => {
            return {
                key: token.symbol,
                value: token.symbol,  
                token: token, 
                text: `${token.symbol}: ${token.name}`,
            };
        });

        let tokenStats;

        if (this.state.tokenStatisticsIsLoading) {
            tokenStats = (
                <TokenStatistics isLoading={this.state.tokenStatisticsIsLoading}/>
            );
        } else if (this.state.tokenStatisticsWarning) {
            tokenStats = (
                <TokenStatistics warning={this.state.tokenStatisticsWarning}/>
            );
        } else if (baseToken && quoteToken && this.state.tokenQuantity.gt(0)) {
            const b = baseToken as Token;
            const q = quoteToken as Token;

            const tokenRateStats: TokenRateStatistics = {
                baseToken,
                quoteToken,
                tokenQuantity: this.state.tokenQuantity,
                lowerBoundExchangeRate,
                upperBoundExchangeRate
            };

            tokenStats = (
                <TokenStatistics tokenRateStatistics={tokenRateStats}/>
            );
        } else {
            const placeholder: TokenStatisticsPlaceholder = {
                quoteToken
            };

            tokenStats = ( 
                <TokenStatistics placeholder={placeholder}/>
            );
        }

        return (
            <Form style={{ height: '100%' }}>
                <ZeroExRelayerWebSocketChannel
                    ref={ref => (this.relayerWsChannel = ref)} 
                    onSnapshot={this.onRelayerSnapshot}
                    onUpdate={this.onRelayerUpdate}
                />
                <Form.Group inline style={{display: 'flex', justifyContent: 'center'}}>
                    <label>I would like to:</label>
                    <Form.Radio
                        control={Radio} 
                        label="Buy" 
                        value="Buy" 
                        checked={this.state.tradeAction === 'Buy'} 
                        onChange={this.handleTradeActionChange} 
                    />
                    <Form.Radio 
                        label="Sell" 
                        value="Sell" 
                        checked={this.state.tradeAction === 'Sell'} 
                        onChange={this.handleTradeActionChange} 
                    />
                </Form.Group>
                <Form.Input 
                    required
                    labelPosition="left"
                    label="Token Quantity" 
                    placeholder="Amount" 
                    onChange={this.handleTokenQuantityChange}
                />
                <Form.Dropdown 
                    required
                    selection 
                    label="Token" 
                    options={tradeAction === 'Buy' ? baseTokenDropDownItems : quoteTokenDropDownItems}
                    onChange={this.handleBaseTokenDropDownItemSelected}
                    placeholder="Token"
                />
                <Form.Dropdown 
                    required
                    selection
                    label="In exchange for:" 
                    options={tradeAction === 'Buy' ? quoteTokenDropDownItems : baseTokenDropDownItems} 
                    onChange={this.handleQuoteTokenDropDownItemSelected}
                    placeholder="Token"
                />
                <Divider horizontal>You Will {tradeAction === 'Buy' ? 'Spend' : 'Purchase'}</Divider>
                {tokenStats}
                <div style={{margin: '1em', display: 'flex', justifyContent: 'center'}}>
                    <Form.Field 
                        required 
                        control={Checkbox} 
                        label="I agree to the Terms and Conditions"   
                    />
                </div>
                <div style={{margin: '1em', display: 'flex', justifyContent: 'center'}}>
                    <Form.Button onClick={this.onClickTrade}>
                        Trade
                    </Form.Button>
                </div>
            </Form>
        );
    }
}