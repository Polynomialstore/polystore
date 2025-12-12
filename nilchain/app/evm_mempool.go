package app

import (
	"fmt"
	"os"

	"cosmossdk.io/log"

	"github.com/cosmos/cosmos-sdk/baseapp"
	"github.com/cosmos/cosmos-sdk/client"
	sdk "github.com/cosmos/cosmos-sdk/types"
	sdkmempool "github.com/cosmos/cosmos-sdk/types/mempool"
	evmtypes "github.com/cosmos/evm/x/vm/types"
	ethtypes "github.com/ethereum/go-ethereum/core/types"

	evmconfig "github.com/cosmos/evm/config"
	evmmempool "github.com/cosmos/evm/mempool"
)

// initEVMMempool sets up the EVM-aware mempool and related handlers.
// It is invoked from app.New() before BaseApp is sealed.
func (app *App) initEVMMempool() error {
	if app.appOpts == nil {
		return nil
	}

	logger := app.logger.With(log.ModuleKey, "evm-mempool")

	logger.Info("configuring EVM mempool")

	if os.Getenv("NIL_DISABLE_EVM_MEMPOOL") == "1" {
		logger.Info("NIL_DISABLE_EVM_MEMPOOL=1; skipping EVM mempool configuration")
		return nil
	}

	cosmosPoolMaxTx := evmconfig.GetCosmosPoolMaxTx(app.appOpts, logger)
	if cosmosPoolMaxTx < 0 {
		logger.Debug("app-side mempool is disabled, skipping EVM mempool configuration")
		return nil
	}

	mempoolConfig, err := app.createMempoolConfig(logger)
	if err != nil {
		return fmt.Errorf("failed to get mempool config: %w", err)
	}

	// We must provide a custom broadcast function because clientCtx is not yet populated
	// when this is called in app.New(). The closure captures 'app' and uses the
	// up-to-date app.clientCtx when invoked later.
	mempoolConfig.BroadCastTxFn = func(txs []*ethtypes.Transaction) error {
		logger.Debug("broadcasting EVM transactions", "tx_count", len(txs))
		return broadcastEVMTransactions(app.clientCtx, app.txConfig, txs)
	}

	evmMempool := evmmempool.NewExperimentalEVMMempool(
		app.CreateQueryContext,
		logger,
		app.EVMKeeper,
		app.FeeMarketKeeper,
		app.txConfig,
		client.Context{}, // Pass empty clientCtx, we use custom BroadCastTxFn
		mempoolConfig,
		cosmosPoolMaxTx,
	)

	app.evmMempool = evmMempool

	// Always use the EVM-aware CheckTx handler so nonce-gap EVM txs are routed
	// into the EVM mempool for future promotion.
	checkTxHandler := evmmempool.NewCheckTxHandler(evmMempool)
	app.SetCheckTxHandler(checkTxHandler)

	// For localhost we keep the EVM mempool for JSON-RPC pending txs, but avoid
	// wiring it into consensus by default. The upstream EVM mempool consensus hooks
	// (SelectBy + EventBus notifications) have been observed to stall single-node
	// chains. Set NIL_USE_EVM_MEMPOOL_FOR_CONSENSUS=1 to opt in.
	if os.Getenv("NIL_USE_EVM_MEMPOOL_FOR_CONSENSUS") == "1" {
		app.SetMempool(evmMempool)
		logger.Info("NIL_USE_EVM_MEMPOOL_FOR_CONSENSUS=1; wiring EVM mempool into BaseApp")

		// The upstream ExperimentalEVMMempool PrepareProposal handler can stall
		// single-node consensus on localhost. Even when opting into consensus wiring,
		// we default to a no-op PrepareProposal so CometBFT proposes its FIFO tx list.
		// Set NIL_DISABLE_EVM_PREPARE_PROPOSAL=0 to opt back into EVM selection.
		if os.Getenv("NIL_DISABLE_EVM_PREPARE_PROPOSAL") == "0" {
			proposalHandler := baseapp.NewDefaultProposalHandler(evmMempool, app.App)
			proposalHandler.SetSignerExtractionAdapter(
				evmmempool.NewEthSignerExtractionAdapter(
					sdkmempool.NewDefaultSignerExtractionAdapter(),
				),
			)
			app.SetPrepareProposal(proposalHandler.PrepareProposalHandler())
			logger.Info("using EVM mempool PrepareProposal handler")
		} else {
			app.SetPrepareProposal(baseapp.NoOpPrepareProposal())
			logger.Info("NIL_DISABLE_EVM_PREPARE_PROPOSAL!=0; using NoOp PrepareProposal")
		}
	} else {
		logger.Info("NIL_USE_EVM_MEMPOOL_FOR_CONSENSUS!=1; EVM mempool enabled only for JSON-RPC")
	}

	logger.Info("configured EVM mempool successfully")

	return nil
}

// createMempoolConfig builds the EVMMempoolConfig from app options.
func (app *App) createMempoolConfig(logger log.Logger) (*evmmempool.EVMMempoolConfig, error) {
	return &evmmempool.EVMMempoolConfig{
		AnteHandler:      app.GetAnteHandler(),
		LegacyPoolConfig: evmconfig.GetLegacyPoolConfig(app.appOpts, logger),
		BlockGasLimit:    evmconfig.GetBlockGasLimit(app.appOpts, logger),
		MinTip:           evmconfig.GetMinTip(app.appOpts, logger),
	}, nil
}

// GetAnteHandler exposes the underlying ante handler used by the EVM mempool.
func (app *App) GetAnteHandler() sdk.AnteHandler {
	return app.AnteHandler()
}

// broadcastEVMTransactions converts Ethereum transactions to Cosmos SDK format and broadcasts them.
func broadcastEVMTransactions(clientCtx client.Context, txConfig client.TxConfig, ethTxs []*ethtypes.Transaction) error {
	for _, ethTx := range ethTxs {
		msg := &evmtypes.MsgEthereumTx{}
		msg.FromEthereumTx(ethTx)

		txBuilder := txConfig.NewTxBuilder()
		if err := txBuilder.SetMsgs(msg); err != nil {
			return fmt.Errorf("failed to set msg in tx builder: %w", err)
		}

		txBytes, err := txConfig.TxEncoder()(txBuilder.GetTx())
		if err != nil {
			return fmt.Errorf("failed to encode transaction: %w", err)
		}

		res, err := clientCtx.BroadcastTxSync(txBytes)
		if err != nil {
			return fmt.Errorf("failed to broadcast transaction %s: %w", ethTx.Hash().Hex(), err)
		}
		if res.Code != 0 {
			return fmt.Errorf("transaction %s rejected by mempool: code=%d, log=%s", ethTx.Hash().Hex(), res.Code, res.RawLog)
		}
	}
	return nil
}
