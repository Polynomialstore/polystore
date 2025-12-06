package app

import (
	"fmt"

	"cosmossdk.io/log"

	"github.com/cosmos/cosmos-sdk/baseapp"
	sdk "github.com/cosmos/cosmos-sdk/types"
	sdkmempool "github.com/cosmos/cosmos-sdk/types/mempool"

	evmconfig "github.com/cosmos/evm/config"
	evmmempool "github.com/cosmos/evm/mempool"
)

// configureEVMMempool sets up the EVM-aware mempool and related handlers.
// It is invoked lazily from SetClientCtx once we have a usable client context.
func (app *App) configureEVMMempool() error {
	if app.appOpts == nil {
		return nil
	}

	logger := app.logger.With(log.ModuleKey, "evm-mempool")

	logger.Info("configuring EVM mempool")

	cosmosPoolMaxTx := evmconfig.GetCosmosPoolMaxTx(app.appOpts, logger)
	if cosmosPoolMaxTx < 0 {
		logger.Debug("app-side mempool is disabled, skipping EVM mempool configuration")
		return nil
	}

	mempoolConfig, err := app.createMempoolConfig(logger)
	if err != nil {
		return fmt.Errorf("failed to get mempool config: %w", err)
	}

	evmMempool := evmmempool.NewExperimentalEVMMempool(
		app.CreateQueryContext,
		logger,
		app.EVMKeeper,
		app.FeeMarketKeeper,
		app.txConfig,
		app.clientCtx,
		mempoolConfig,
		cosmosPoolMaxTx,
	)

	app.evmMempool = evmMempool

	// Wire EVM mempool into BaseApp.
	app.SetMempool(evmMempool)
	checkTxHandler := evmmempool.NewCheckTxHandler(evmMempool)
	app.SetCheckTxHandler(checkTxHandler)

	proposalHandler := baseapp.NewDefaultProposalHandler(evmMempool, app.App)
	proposalHandler.SetSignerExtractionAdapter(
		evmmempool.NewEthSignerExtractionAdapter(
			sdkmempool.NewDefaultSignerExtractionAdapter(),
		),
	)
	app.SetPrepareProposal(proposalHandler.PrepareProposalHandler())

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
