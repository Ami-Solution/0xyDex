import * as React from 'react';
import * as _ from 'lodash';
import { ZeroEx, Token } from '0x.js';
import { Web3Wrapper } from '@0xproject/web3-wrapper';
import * as Web3 from 'web3';
import { BigNumber } from '@0xproject/utils';
import { 
    Button, 
    Container, 
    Table, 
    Header, 
    List, 
    Image, 
    Divider, 
    Card,
    Segment, 
    Icon 
} from 'semantic-ui-react';
import { BalanceTableRow } from '../Account/BalanceTableRow';
import { TokenBalance } from '../App';
import { Dictionary } from 'lodash';
import * as blockies from 'ethereum-blockies';

interface Props {
    accounts: string[];
    onChainTokenBalances: Dictionary<TokenBalance>;
    offChainTokenBalances: Dictionary<TokenBalance>;
    etherBalance: BigNumber;
    fetchAccountDetailsAsync: () => void;
}

const ETHER_TOKEN_NAME = 'ETH';

export default class Account extends React.Component<Props, {}> {

    constructor(props: Props) {
        super(props);
    }

    render() {
        
        const account = this.props.accounts[0];
        const onChainBalances = this.props.onChainTokenBalances;
        const offChainBalances = this.props.offChainTokenBalances;
        const etherBalance = this.props.etherBalance.toString();

        // Icon is a canvas object
        const icon = blockies.create({
            seed: this.props.accounts[0],
            size: 15,
            scale: 3, 
        });

        const imageSrc = icon.toDataURL();

        let onChainBalanceTable;
        let offChainBalanceTable;
        if (Object.keys(onChainBalances).length > 0) {
            const onChainTokenBalances = _.map(onChainBalances, (v: TokenBalance, k: string) => {
                const pairString = `${k}: ${v.balance}`;
                return (
                    <BalanceTableRow 
                        key={pairString} 
                        tokenName={v.token.name}
                        tokenSymbol={v.token.symbol}
                        value={v.balance.toString()}
                    />
                );
            });

            onChainBalanceTable = (
                <div>
                    <Divider horizontal>On-Chain Token Balances</Divider>
                    <Container style={{display: 'flex', justifyContent: 'center'}}>
                        <Table basic="very" collapsing size="large" style={{width: '100%'}}>
                            <Table.Header>
                                <Table.Row>
                                    <Table.HeaderCell>Token</Table.HeaderCell>
                                    <Table.HeaderCell>Balance</Table.HeaderCell>
                                </Table.Row>
                            </Table.Header>
                            <Table.Body>
                                {onChainTokenBalances}
                            </Table.Body>
                        </Table>
                    </Container>
                </div>
            );
        }

        if (Object.keys(offChainBalances).length > 0) {

            const offChainTokenBalances = _.map(offChainBalances, (v: TokenBalance, k: string) => {
                const pairString = `${k}: ${v.balance}`;
                return (
                    <BalanceTableRow 
                        key={pairString} 
                        tokenName={v.token.name}
                        tokenSymbol={v.token.symbol}
                        value={v.balance.toString()}
                    />
                );
            });

            offChainBalanceTable = (
                <div>
                    <Divider horizontal>Off-Chain Token Balances</Divider>
                    <Container style={{display: 'flex', justifyContent: 'center'}}>
                        <Table basic="very" collapsing size="large" style={{width: '100%'}}>
                            <Table.Header>
                                <Table.Row>
                                    <Table.HeaderCell>Token</Table.HeaderCell>
                                    <Table.HeaderCell>Balance</Table.HeaderCell>
                                </Table.Row>
                            </Table.Header>
                            <Table.Body>
                                {offChainTokenBalances}
                            </Table.Body>
                        </Table>
                    </Container>
                </div>
            );
        }

        if (etherBalance && account.length > 0) {
            return (
                <Segment 
                    style={{ 
                        padding: '2em 2em 2em 2em', 
                        minWidth: '100%',
                    }}
                >
                        <Header as="h2" textAlign="center">
                            Wallet
                        </Header>
                    <List size="medium">
                        <List.Item>
                            <Image avatar src={imageSrc}/>
                            <List.Content>
                                <List.Header>Account Address:</List.Header>
                                <List.Description>{account.toString()}</List.Description>
                            </List.Content>
                        </List.Item>
                        <List.Item>
                            <Image 
                                avatar 
                                src="/token_icons/ETH.png"
                            />
                            <List.Content>
                                <List.Header>Balance:</List.Header>
                                <List.Description>{etherBalance} ETH</List.Description>
                            </List.Content>
                        </List.Item>
                    </List>
                    {onChainBalanceTable}
                    {offChainBalanceTable}
                </Segment>
            );
        } else {
            return (
                <Card 
                    raised={true} 
                    centered={true} 
                    style={{ 
                        padding: '1em 1em 1em 1em', 
                        marginTop: '0px !important', 
                        marginLeft: 'auto', 
                        marginRight: 'auto',
                        minWidth: '100%',
                    }}
                > 
                    <p> Detecting Metamask... Please ensure Metamask is unlocked </p>
                    <Button id="fetchAccountBalances" onClick={this.props.fetchAccountDetailsAsync}>
                        Fetch Balances
                    </Button>
                </Card>
            );
        }
    }
}
