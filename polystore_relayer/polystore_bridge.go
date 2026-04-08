// Code generated - DO NOT EDIT.
// This file is a generated binding and any manual changes will be lost.

package main

import (
	"errors"
	"math/big"
	"strings"

	ethereum "github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/event"
)

// Reference imports to suppress errors if they are not otherwise used.
var (
	_ = errors.New
	_ = big.NewInt
	_ = strings.NewReader
	_ = ethereum.NotFound
	_ = bind.Bind
	_ = common.Big1
	_ = types.BloomLookup
	_ = event.NewSubscription
	_ = abi.ConvertType
)

// PolyStoreBridgeMetaData contains all meta data concerning the PolyStoreBridge contract.
var PolyStoreBridgeMetaData = &bind.MetaData{
	ABI: "[{\"type\":\"constructor\",\"inputs\":[],\"stateMutability\":\"nonpayable\"},{\"type\":\"function\",\"name\":\"latestBlockHeight\",\"inputs\":[],\"outputs\":[{\"name\":\"\",\"type\":\"uint256\",\"internalType\":\"uint256\"}],\"stateMutability\":\"view\"},{\"type\":\"function\",\"name\":\"latestStateRoot\",\"inputs\":[],\"outputs\":[{\"name\":\"\",\"type\":\"bytes32\",\"internalType\":\"bytes32\"}],\"stateMutability\":\"view\"},{\"type\":\"function\",\"name\":\"owner\",\"inputs\":[],\"outputs\":[{\"name\":\"\",\"type\":\"address\",\"internalType\":\"address\"}],\"stateMutability\":\"view\"},{\"type\":\"function\",\"name\":\"updateStateRoot\",\"inputs\":[{\"name\":\"blockHeight\",\"type\":\"uint256\",\"internalType\":\"uint256\"},{\"name\":\"stateRoot\",\"type\":\"bytes32\",\"internalType\":\"bytes32\"}],\"outputs\":[],\"stateMutability\":\"nonpayable\"},{\"type\":\"function\",\"name\":\"verifyInclusion\",\"inputs\":[{\"name\":\"leaf\",\"type\":\"bytes32\",\"internalType\":\"bytes32\"},{\"name\":\"proof\",\"type\":\"bytes32[]\",\"internalType\":\"bytes32[]\"}],\"outputs\":[{\"name\":\"\",\"type\":\"bool\",\"internalType\":\"bool\"}],\"stateMutability\":\"view\"},{\"type\":\"event\",\"name\":\"StateRootUpdated\",\"inputs\":[{\"name\":\"blockHeight\",\"type\":\"uint256\",\"indexed\":true,\"internalType\":\"uint256\"},{\"name\":\"stateRoot\",\"type\":\"bytes32\",\"indexed\":false,\"internalType\":\"bytes32\"}],\"anonymous\":false}]",
}

// PolyStoreBridgeABI is the input ABI used to generate the binding from.
// Deprecated: Use PolyStoreBridgeMetaData.ABI instead.
var PolyStoreBridgeABI = PolyStoreBridgeMetaData.ABI

// PolyStoreBridge is an auto generated Go binding around an Ethereum contract.
type PolyStoreBridge struct {
	PolyStoreBridgeCaller     // Read-only binding to the contract
	PolyStoreBridgeTransactor // Write-only binding to the contract
	PolyStoreBridgeFilterer   // Log filterer for contract events
}

// PolyStoreBridgeCaller is an auto generated read-only Go binding around an Ethereum contract.
type PolyStoreBridgeCaller struct {
	contract *bind.BoundContract // Generic contract wrapper for the low level calls
}

// PolyStoreBridgeTransactor is an auto generated write-only Go binding around an Ethereum contract.
type PolyStoreBridgeTransactor struct {
	contract *bind.BoundContract // Generic contract wrapper for the low level calls
}

// PolyStoreBridgeFilterer is an auto generated log filtering Go binding around an Ethereum contract events.
type PolyStoreBridgeFilterer struct {
	contract *bind.BoundContract // Generic contract wrapper for the low level calls
}

// PolyStoreBridgeSession is an auto generated Go binding around an Ethereum contract,
// with pre-set call and transact options.
type PolyStoreBridgeSession struct {
	Contract     *PolyStoreBridge        // Generic contract binding to set the session for
	CallOpts     bind.CallOpts     // Call options to use throughout this session
	TransactOpts bind.TransactOpts // Transaction auth options to use throughout this session
}

// PolyStoreBridgeCallerSession is an auto generated read-only Go binding around an Ethereum contract,
// with pre-set call options.
type PolyStoreBridgeCallerSession struct {
	Contract *PolyStoreBridgeCaller // Generic contract caller binding to set the session for
	CallOpts bind.CallOpts    // Call options to use throughout this session
}

// PolyStoreBridgeTransactorSession is an auto generated write-only Go binding around an Ethereum contract,
// with pre-set transact options.
type PolyStoreBridgeTransactorSession struct {
	Contract     *PolyStoreBridgeTransactor // Generic contract transactor binding to set the session for
	TransactOpts bind.TransactOpts    // Transaction auth options to use throughout this session
}

// PolyStoreBridgeRaw is an auto generated low-level Go binding around an Ethereum contract.
type PolyStoreBridgeRaw struct {
	Contract *PolyStoreBridge // Generic contract binding to access the raw methods on
}

// PolyStoreBridgeCallerRaw is an auto generated low-level read-only Go binding around an Ethereum contract.
type PolyStoreBridgeCallerRaw struct {
	Contract *PolyStoreBridgeCaller // Generic read-only contract binding to access the raw methods on
}

// PolyStoreBridgeTransactorRaw is an auto generated low-level write-only Go binding around an Ethereum contract.
type PolyStoreBridgeTransactorRaw struct {
	Contract *PolyStoreBridgeTransactor // Generic write-only contract binding to access the raw methods on
}

// NewPolyStoreBridge creates a new instance of PolyStoreBridge, bound to a specific deployed contract.
func NewPolyStoreBridge(address common.Address, backend bind.ContractBackend) (*PolyStoreBridge, error) {
	contract, err := bindPolyStoreBridge(address, backend, backend, backend)
	if err != nil {
		return nil, err
	}
	return &PolyStoreBridge{PolyStoreBridgeCaller: PolyStoreBridgeCaller{contract: contract}, PolyStoreBridgeTransactor: PolyStoreBridgeTransactor{contract: contract}, PolyStoreBridgeFilterer: PolyStoreBridgeFilterer{contract: contract}}, nil
}

// NewPolyStoreBridgeCaller creates a new read-only instance of PolyStoreBridge, bound to a specific deployed contract.
func NewPolyStoreBridgeCaller(address common.Address, caller bind.ContractCaller) (*PolyStoreBridgeCaller, error) {
	contract, err := bindPolyStoreBridge(address, caller, nil, nil)
	if err != nil {
		return nil, err
	}
	return &PolyStoreBridgeCaller{contract: contract}, nil
}

// NewPolyStoreBridgeTransactor creates a new write-only instance of PolyStoreBridge, bound to a specific deployed contract.
func NewPolyStoreBridgeTransactor(address common.Address, transactor bind.ContractTransactor) (*PolyStoreBridgeTransactor, error) {
	contract, err := bindPolyStoreBridge(address, nil, transactor, nil)
	if err != nil {
		return nil, err
	}
	return &PolyStoreBridgeTransactor{contract: contract}, nil
}

// NewPolyStoreBridgeFilterer creates a new log filterer instance of PolyStoreBridge, bound to a specific deployed contract.
func NewPolyStoreBridgeFilterer(address common.Address, filterer bind.ContractFilterer) (*PolyStoreBridgeFilterer, error) {
	contract, err := bindPolyStoreBridge(address, nil, nil, filterer)
	if err != nil {
		return nil, err
	}
	return &PolyStoreBridgeFilterer{contract: contract}, nil
}

// bindPolyStoreBridge binds a generic wrapper to an already deployed contract.
func bindPolyStoreBridge(address common.Address, caller bind.ContractCaller, transactor bind.ContractTransactor, filterer bind.ContractFilterer) (*bind.BoundContract, error) {
	parsed, err := PolyStoreBridgeMetaData.GetAbi()
	if err != nil {
		return nil, err
	}
	return bind.NewBoundContract(address, *parsed, caller, transactor, filterer), nil
}

// Call invokes the (constant) contract method with params as input values and
// sets the output to result. The result type might be a single field for simple
// returns, a slice of interfaces for anonymous returns and a struct for named
// returns.
func (_PolyStoreBridge *PolyStoreBridgeRaw) Call(opts *bind.CallOpts, result *[]interface{}, method string, params ...interface{}) error {
	return _PolyStoreBridge.Contract.PolyStoreBridgeCaller.contract.Call(opts, result, method, params...)
}

// Transfer initiates a plain transaction to move funds to the contract, calling
// its default method if one is available.
func (_PolyStoreBridge *PolyStoreBridgeRaw) Transfer(opts *bind.TransactOpts) (*types.Transaction, error) {
	return _PolyStoreBridge.Contract.PolyStoreBridgeTransactor.contract.Transfer(opts)
}

// Transact invokes the (paid) contract method with params as input values.
func (_PolyStoreBridge *PolyStoreBridgeRaw) Transact(opts *bind.TransactOpts, method string, params ...interface{}) (*types.Transaction, error) {
	return _PolyStoreBridge.Contract.PolyStoreBridgeTransactor.contract.Transact(opts, method, params...)
}

// Call invokes the (constant) contract method with params as input values and
// sets the output to result. The result type might be a single field for simple
// returns, a slice of interfaces for anonymous returns and a struct for named
// returns.
func (_PolyStoreBridge *PolyStoreBridgeCallerRaw) Call(opts *bind.CallOpts, result *[]interface{}, method string, params ...interface{}) error {
	return _PolyStoreBridge.Contract.contract.Call(opts, result, method, params...)
}

// Transfer initiates a plain transaction to move funds to the contract, calling
// its default method if one is available.
func (_PolyStoreBridge *PolyStoreBridgeTransactorRaw) Transfer(opts *bind.TransactOpts) (*types.Transaction, error) {
	return _PolyStoreBridge.Contract.contract.Transfer(opts)
}

// Transact invokes the (paid) contract method with params as input values.
func (_PolyStoreBridge *PolyStoreBridgeTransactorRaw) Transact(opts *bind.TransactOpts, method string, params ...interface{}) (*types.Transaction, error) {
	return _PolyStoreBridge.Contract.contract.Transact(opts, method, params...)
}

// LatestBlockHeight is a free data retrieval call binding the contract method 0xf3f39ee5.
//
// Solidity: function latestBlockHeight() view returns(uint256)
func (_PolyStoreBridge *PolyStoreBridgeCaller) LatestBlockHeight(opts *bind.CallOpts) (*big.Int, error) {
	var out []interface{}
	err := _PolyStoreBridge.contract.Call(opts, &out, "latestBlockHeight")

	if err != nil {
		return *new(*big.Int), err
	}

	out0 := *abi.ConvertType(out[0], new(*big.Int)).(**big.Int)

	return out0, err

}

// LatestBlockHeight is a free data retrieval call binding the contract method 0xf3f39ee5.
//
// Solidity: function latestBlockHeight() view returns(uint256)
func (_PolyStoreBridge *PolyStoreBridgeSession) LatestBlockHeight() (*big.Int, error) {
	return _PolyStoreBridge.Contract.LatestBlockHeight(&_PolyStoreBridge.CallOpts)
}

// LatestBlockHeight is a free data retrieval call binding the contract method 0xf3f39ee5.
//
// Solidity: function latestBlockHeight() view returns(uint256)
func (_PolyStoreBridge *PolyStoreBridgeCallerSession) LatestBlockHeight() (*big.Int, error) {
	return _PolyStoreBridge.Contract.LatestBlockHeight(&_PolyStoreBridge.CallOpts)
}

// LatestStateRoot is a free data retrieval call binding the contract method 0x991beafd.
//
// Solidity: function latestStateRoot() view returns(bytes32)
func (_PolyStoreBridge *PolyStoreBridgeCaller) LatestStateRoot(opts *bind.CallOpts) ([32]byte, error) {
	var out []interface{}
	err := _PolyStoreBridge.contract.Call(opts, &out, "latestStateRoot")

	if err != nil {
		return *new([32]byte), err
	}

	out0 := *abi.ConvertType(out[0], new([32]byte)).(*[32]byte)

	return out0, err

}

// LatestStateRoot is a free data retrieval call binding the contract method 0x991beafd.
//
// Solidity: function latestStateRoot() view returns(bytes32)
func (_PolyStoreBridge *PolyStoreBridgeSession) LatestStateRoot() ([32]byte, error) {
	return _PolyStoreBridge.Contract.LatestStateRoot(&_PolyStoreBridge.CallOpts)
}

// LatestStateRoot is a free data retrieval call binding the contract method 0x991beafd.
//
// Solidity: function latestStateRoot() view returns(bytes32)
func (_PolyStoreBridge *PolyStoreBridgeCallerSession) LatestStateRoot() ([32]byte, error) {
	return _PolyStoreBridge.Contract.LatestStateRoot(&_PolyStoreBridge.CallOpts)
}

// Owner is a free data retrieval call binding the contract method 0x8da5cb5b.
//
// Solidity: function owner() view returns(address)
func (_PolyStoreBridge *PolyStoreBridgeCaller) Owner(opts *bind.CallOpts) (common.Address, error) {
	var out []interface{}
	err := _PolyStoreBridge.contract.Call(opts, &out, "owner")

	if err != nil {
		return *new(common.Address), err
	}

	out0 := *abi.ConvertType(out[0], new(common.Address)).(*common.Address)

	return out0, err

}

// Owner is a free data retrieval call binding the contract method 0x8da5cb5b.
//
// Solidity: function owner() view returns(address)
func (_PolyStoreBridge *PolyStoreBridgeSession) Owner() (common.Address, error) {
	return _PolyStoreBridge.Contract.Owner(&_PolyStoreBridge.CallOpts)
}

// Owner is a free data retrieval call binding the contract method 0x8da5cb5b.
//
// Solidity: function owner() view returns(address)
func (_PolyStoreBridge *PolyStoreBridgeCallerSession) Owner() (common.Address, error) {
	return _PolyStoreBridge.Contract.Owner(&_PolyStoreBridge.CallOpts)
}

// VerifyInclusion is a free data retrieval call binding the contract method 0x67c6c8bc.
//
// Solidity: function verifyInclusion(bytes32 leaf, bytes32[] proof) view returns(bool)
func (_PolyStoreBridge *PolyStoreBridgeCaller) VerifyInclusion(opts *bind.CallOpts, leaf [32]byte, proof [][32]byte) (bool, error) {
	var out []interface{}
	err := _PolyStoreBridge.contract.Call(opts, &out, "verifyInclusion", leaf, proof)

	if err != nil {
		return *new(bool), err
	}

	out0 := *abi.ConvertType(out[0], new(bool)).(*bool)

	return out0, err

}

// VerifyInclusion is a free data retrieval call binding the contract method 0x67c6c8bc.
//
// Solidity: function verifyInclusion(bytes32 leaf, bytes32[] proof) view returns(bool)
func (_PolyStoreBridge *PolyStoreBridgeSession) VerifyInclusion(leaf [32]byte, proof [][32]byte) (bool, error) {
	return _PolyStoreBridge.Contract.VerifyInclusion(&_PolyStoreBridge.CallOpts, leaf, proof)
}

// VerifyInclusion is a free data retrieval call binding the contract method 0x67c6c8bc.
//
// Solidity: function verifyInclusion(bytes32 leaf, bytes32[] proof) view returns(bool)
func (_PolyStoreBridge *PolyStoreBridgeCallerSession) VerifyInclusion(leaf [32]byte, proof [][32]byte) (bool, error) {
	return _PolyStoreBridge.Contract.VerifyInclusion(&_PolyStoreBridge.CallOpts, leaf, proof)
}

// UpdateStateRoot is a paid mutator transaction binding the contract method 0xdb33005a.
//
// Solidity: function updateStateRoot(uint256 blockHeight, bytes32 stateRoot) returns()
func (_PolyStoreBridge *PolyStoreBridgeTransactor) UpdateStateRoot(opts *bind.TransactOpts, blockHeight *big.Int, stateRoot [32]byte) (*types.Transaction, error) {
	return _PolyStoreBridge.contract.Transact(opts, "updateStateRoot", blockHeight, stateRoot)
}

// UpdateStateRoot is a paid mutator transaction binding the contract method 0xdb33005a.
//
// Solidity: function updateStateRoot(uint256 blockHeight, bytes32 stateRoot) returns()
func (_PolyStoreBridge *PolyStoreBridgeSession) UpdateStateRoot(blockHeight *big.Int, stateRoot [32]byte) (*types.Transaction, error) {
	return _PolyStoreBridge.Contract.UpdateStateRoot(&_PolyStoreBridge.TransactOpts, blockHeight, stateRoot)
}

// UpdateStateRoot is a paid mutator transaction binding the contract method 0xdb33005a.
//
// Solidity: function updateStateRoot(uint256 blockHeight, bytes32 stateRoot) returns()
func (_PolyStoreBridge *PolyStoreBridgeTransactorSession) UpdateStateRoot(blockHeight *big.Int, stateRoot [32]byte) (*types.Transaction, error) {
	return _PolyStoreBridge.Contract.UpdateStateRoot(&_PolyStoreBridge.TransactOpts, blockHeight, stateRoot)
}

// PolyStoreBridgeStateRootUpdatedIterator is returned from FilterStateRootUpdated and is used to iterate over the raw logs and unpacked data for StateRootUpdated events raised by the PolyStoreBridge contract.
type PolyStoreBridgeStateRootUpdatedIterator struct {
	Event *PolyStoreBridgeStateRootUpdated // Event containing the contract specifics and raw log

	contract *bind.BoundContract // Generic contract to use for unpacking event data
	event    string              // Event name to use for unpacking event data

	logs chan types.Log        // Log channel receiving the found contract events
	sub  ethereum.Subscription // Subscription for errors, completion and termination
	done bool                  // Whether the subscription completed delivering logs
	fail error                 // Occurred error to stop iteration
}

// Next advances the iterator to the subsequent event, returning whether there
// are any more events found. In case of a retrieval or parsing error, false is
// returned and Error() can be queried for the exact failure.
func (it *PolyStoreBridgeStateRootUpdatedIterator) Next() bool {
	// If the iterator failed, stop iterating
	if it.fail != nil {
		return false
	}
	// If the iterator completed, deliver directly whatever's available
	if it.done {
		select {
		case log := <-it.logs:
			it.Event = new(PolyStoreBridgeStateRootUpdated)
			if err := it.contract.UnpackLog(it.Event, it.event, log); err != nil {
				it.fail = err
				return false
			}
			it.Event.Raw = log
			return true

		default:
			return false
		}
	}
	// Iterator still in progress, wait for either a data or an error event
	select {
	case log := <-it.logs:
		it.Event = new(PolyStoreBridgeStateRootUpdated)
		if err := it.contract.UnpackLog(it.Event, it.event, log); err != nil {
			it.fail = err
			return false
		}
		it.Event.Raw = log
		return true

	case err := <-it.sub.Err():
		it.done = true
		it.fail = err
		return it.Next()
	}
}

// Error returns any retrieval or parsing error occurred during filtering.
func (it *PolyStoreBridgeStateRootUpdatedIterator) Error() error {
	return it.fail
}

// Close terminates the iteration process, releasing any pending underlying
// resources.
func (it *PolyStoreBridgeStateRootUpdatedIterator) Close() error {
	it.sub.Unsubscribe()
	return nil
}

// PolyStoreBridgeStateRootUpdated represents a StateRootUpdated event raised by the PolyStoreBridge contract.
type PolyStoreBridgeStateRootUpdated struct {
	BlockHeight *big.Int
	StateRoot   [32]byte
	Raw         types.Log // Blockchain specific contextual infos
}

// FilterStateRootUpdated is a free log retrieval operation binding the contract event 0x81c72bbfba8aa5c196bf46c414765acaeb81b0c575e622425873c001dc6f350d.
//
// Solidity: event StateRootUpdated(uint256 indexed blockHeight, bytes32 stateRoot)
func (_PolyStoreBridge *PolyStoreBridgeFilterer) FilterStateRootUpdated(opts *bind.FilterOpts, blockHeight []*big.Int) (*PolyStoreBridgeStateRootUpdatedIterator, error) {

	var blockHeightRule []interface{}
	for _, blockHeightItem := range blockHeight {
		blockHeightRule = append(blockHeightRule, blockHeightItem)
	}

	logs, sub, err := _PolyStoreBridge.contract.FilterLogs(opts, "StateRootUpdated", blockHeightRule)
	if err != nil {
		return nil, err
	}
	return &PolyStoreBridgeStateRootUpdatedIterator{contract: _PolyStoreBridge.contract, event: "StateRootUpdated", logs: logs, sub: sub}, nil
}

// WatchStateRootUpdated is a free log subscription operation binding the contract event 0x81c72bbfba8aa5c196bf46c414765acaeb81b0c575e622425873c001dc6f350d.
//
// Solidity: event StateRootUpdated(uint256 indexed blockHeight, bytes32 stateRoot)
func (_PolyStoreBridge *PolyStoreBridgeFilterer) WatchStateRootUpdated(opts *bind.WatchOpts, sink chan<- *PolyStoreBridgeStateRootUpdated, blockHeight []*big.Int) (event.Subscription, error) {

	var blockHeightRule []interface{}
	for _, blockHeightItem := range blockHeight {
		blockHeightRule = append(blockHeightRule, blockHeightItem)
	}

	logs, sub, err := _PolyStoreBridge.contract.WatchLogs(opts, "StateRootUpdated", blockHeightRule)
	if err != nil {
		return nil, err
	}
	return event.NewSubscription(func(quit <-chan struct{}) error {
		defer sub.Unsubscribe()
		for {
			select {
			case log := <-logs:
				// New log arrived, parse the event and forward to the user
				event := new(PolyStoreBridgeStateRootUpdated)
				if err := _PolyStoreBridge.contract.UnpackLog(event, "StateRootUpdated", log); err != nil {
					return err
				}
				event.Raw = log

				select {
				case sink <- event:
				case err := <-sub.Err():
					return err
				case <-quit:
					return nil
				}
			case err := <-sub.Err():
				return err
			case <-quit:
				return nil
			}
		}
	}), nil
}

// ParseStateRootUpdated is a log parse operation binding the contract event 0x81c72bbfba8aa5c196bf46c414765acaeb81b0c575e622425873c001dc6f350d.
//
// Solidity: event StateRootUpdated(uint256 indexed blockHeight, bytes32 stateRoot)
func (_PolyStoreBridge *PolyStoreBridgeFilterer) ParseStateRootUpdated(log types.Log) (*PolyStoreBridgeStateRootUpdated, error) {
	event := new(PolyStoreBridgeStateRootUpdated)
	if err := _PolyStoreBridge.contract.UnpackLog(event, "StateRootUpdated", log); err != nil {
		return nil, err
	}
	event.Raw = log
	return event, nil
}
