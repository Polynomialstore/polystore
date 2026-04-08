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

// NilBridgeMetaData contains all meta data concerning the NilBridge contract.
var NilBridgeMetaData = &bind.MetaData{
	ABI: "[{\"type\":\"constructor\",\"inputs\":[],\"stateMutability\":\"nonpayable\"},{\"type\":\"function\",\"name\":\"latestBlockHeight\",\"inputs\":[],\"outputs\":[{\"name\":\"\",\"type\":\"uint256\",\"internalType\":\"uint256\"}],\"stateMutability\":\"view\"},{\"type\":\"function\",\"name\":\"latestStateRoot\",\"inputs\":[],\"outputs\":[{\"name\":\"\",\"type\":\"bytes32\",\"internalType\":\"bytes32\"}],\"stateMutability\":\"view\"},{\"type\":\"function\",\"name\":\"owner\",\"inputs\":[],\"outputs\":[{\"name\":\"\",\"type\":\"address\",\"internalType\":\"address\"}],\"stateMutability\":\"view\"},{\"type\":\"function\",\"name\":\"updateStateRoot\",\"inputs\":[{\"name\":\"blockHeight\",\"type\":\"uint256\",\"internalType\":\"uint256\"},{\"name\":\"stateRoot\",\"type\":\"bytes32\",\"internalType\":\"bytes32\"}],\"outputs\":[],\"stateMutability\":\"nonpayable\"},{\"type\":\"function\",\"name\":\"verifyInclusion\",\"inputs\":[{\"name\":\"leaf\",\"type\":\"bytes32\",\"internalType\":\"bytes32\"},{\"name\":\"proof\",\"type\":\"bytes32[]\",\"internalType\":\"bytes32[]\"}],\"outputs\":[{\"name\":\"\",\"type\":\"bool\",\"internalType\":\"bool\"}],\"stateMutability\":\"view\"},{\"type\":\"event\",\"name\":\"StateRootUpdated\",\"inputs\":[{\"name\":\"blockHeight\",\"type\":\"uint256\",\"indexed\":true,\"internalType\":\"uint256\"},{\"name\":\"stateRoot\",\"type\":\"bytes32\",\"indexed\":false,\"internalType\":\"bytes32\"}],\"anonymous\":false}]",
}

// NilBridgeABI is the input ABI used to generate the binding from.
// Deprecated: Use NilBridgeMetaData.ABI instead.
var NilBridgeABI = NilBridgeMetaData.ABI

// NilBridge is an auto generated Go binding around an Ethereum contract.
type NilBridge struct {
	NilBridgeCaller     // Read-only binding to the contract
	NilBridgeTransactor // Write-only binding to the contract
	NilBridgeFilterer   // Log filterer for contract events
}

// NilBridgeCaller is an auto generated read-only Go binding around an Ethereum contract.
type NilBridgeCaller struct {
	contract *bind.BoundContract // Generic contract wrapper for the low level calls
}

// NilBridgeTransactor is an auto generated write-only Go binding around an Ethereum contract.
type NilBridgeTransactor struct {
	contract *bind.BoundContract // Generic contract wrapper for the low level calls
}

// NilBridgeFilterer is an auto generated log filtering Go binding around an Ethereum contract events.
type NilBridgeFilterer struct {
	contract *bind.BoundContract // Generic contract wrapper for the low level calls
}

// NilBridgeSession is an auto generated Go binding around an Ethereum contract,
// with pre-set call and transact options.
type NilBridgeSession struct {
	Contract     *NilBridge        // Generic contract binding to set the session for
	CallOpts     bind.CallOpts     // Call options to use throughout this session
	TransactOpts bind.TransactOpts // Transaction auth options to use throughout this session
}

// NilBridgeCallerSession is an auto generated read-only Go binding around an Ethereum contract,
// with pre-set call options.
type NilBridgeCallerSession struct {
	Contract *NilBridgeCaller // Generic contract caller binding to set the session for
	CallOpts bind.CallOpts    // Call options to use throughout this session
}

// NilBridgeTransactorSession is an auto generated write-only Go binding around an Ethereum contract,
// with pre-set transact options.
type NilBridgeTransactorSession struct {
	Contract     *NilBridgeTransactor // Generic contract transactor binding to set the session for
	TransactOpts bind.TransactOpts    // Transaction auth options to use throughout this session
}

// NilBridgeRaw is an auto generated low-level Go binding around an Ethereum contract.
type NilBridgeRaw struct {
	Contract *NilBridge // Generic contract binding to access the raw methods on
}

// NilBridgeCallerRaw is an auto generated low-level read-only Go binding around an Ethereum contract.
type NilBridgeCallerRaw struct {
	Contract *NilBridgeCaller // Generic read-only contract binding to access the raw methods on
}

// NilBridgeTransactorRaw is an auto generated low-level write-only Go binding around an Ethereum contract.
type NilBridgeTransactorRaw struct {
	Contract *NilBridgeTransactor // Generic write-only contract binding to access the raw methods on
}

// NewNilBridge creates a new instance of NilBridge, bound to a specific deployed contract.
func NewNilBridge(address common.Address, backend bind.ContractBackend) (*NilBridge, error) {
	contract, err := bindNilBridge(address, backend, backend, backend)
	if err != nil {
		return nil, err
	}
	return &NilBridge{NilBridgeCaller: NilBridgeCaller{contract: contract}, NilBridgeTransactor: NilBridgeTransactor{contract: contract}, NilBridgeFilterer: NilBridgeFilterer{contract: contract}}, nil
}

// NewNilBridgeCaller creates a new read-only instance of NilBridge, bound to a specific deployed contract.
func NewNilBridgeCaller(address common.Address, caller bind.ContractCaller) (*NilBridgeCaller, error) {
	contract, err := bindNilBridge(address, caller, nil, nil)
	if err != nil {
		return nil, err
	}
	return &NilBridgeCaller{contract: contract}, nil
}

// NewNilBridgeTransactor creates a new write-only instance of NilBridge, bound to a specific deployed contract.
func NewNilBridgeTransactor(address common.Address, transactor bind.ContractTransactor) (*NilBridgeTransactor, error) {
	contract, err := bindNilBridge(address, nil, transactor, nil)
	if err != nil {
		return nil, err
	}
	return &NilBridgeTransactor{contract: contract}, nil
}

// NewNilBridgeFilterer creates a new log filterer instance of NilBridge, bound to a specific deployed contract.
func NewNilBridgeFilterer(address common.Address, filterer bind.ContractFilterer) (*NilBridgeFilterer, error) {
	contract, err := bindNilBridge(address, nil, nil, filterer)
	if err != nil {
		return nil, err
	}
	return &NilBridgeFilterer{contract: contract}, nil
}

// bindNilBridge binds a generic wrapper to an already deployed contract.
func bindNilBridge(address common.Address, caller bind.ContractCaller, transactor bind.ContractTransactor, filterer bind.ContractFilterer) (*bind.BoundContract, error) {
	parsed, err := NilBridgeMetaData.GetAbi()
	if err != nil {
		return nil, err
	}
	return bind.NewBoundContract(address, *parsed, caller, transactor, filterer), nil
}

// Call invokes the (constant) contract method with params as input values and
// sets the output to result. The result type might be a single field for simple
// returns, a slice of interfaces for anonymous returns and a struct for named
// returns.
func (_NilBridge *NilBridgeRaw) Call(opts *bind.CallOpts, result *[]interface{}, method string, params ...interface{}) error {
	return _NilBridge.Contract.NilBridgeCaller.contract.Call(opts, result, method, params...)
}

// Transfer initiates a plain transaction to move funds to the contract, calling
// its default method if one is available.
func (_NilBridge *NilBridgeRaw) Transfer(opts *bind.TransactOpts) (*types.Transaction, error) {
	return _NilBridge.Contract.NilBridgeTransactor.contract.Transfer(opts)
}

// Transact invokes the (paid) contract method with params as input values.
func (_NilBridge *NilBridgeRaw) Transact(opts *bind.TransactOpts, method string, params ...interface{}) (*types.Transaction, error) {
	return _NilBridge.Contract.NilBridgeTransactor.contract.Transact(opts, method, params...)
}

// Call invokes the (constant) contract method with params as input values and
// sets the output to result. The result type might be a single field for simple
// returns, a slice of interfaces for anonymous returns and a struct for named
// returns.
func (_NilBridge *NilBridgeCallerRaw) Call(opts *bind.CallOpts, result *[]interface{}, method string, params ...interface{}) error {
	return _NilBridge.Contract.contract.Call(opts, result, method, params...)
}

// Transfer initiates a plain transaction to move funds to the contract, calling
// its default method if one is available.
func (_NilBridge *NilBridgeTransactorRaw) Transfer(opts *bind.TransactOpts) (*types.Transaction, error) {
	return _NilBridge.Contract.contract.Transfer(opts)
}

// Transact invokes the (paid) contract method with params as input values.
func (_NilBridge *NilBridgeTransactorRaw) Transact(opts *bind.TransactOpts, method string, params ...interface{}) (*types.Transaction, error) {
	return _NilBridge.Contract.contract.Transact(opts, method, params...)
}

// LatestBlockHeight is a free data retrieval call binding the contract method 0xf3f39ee5.
//
// Solidity: function latestBlockHeight() view returns(uint256)
func (_NilBridge *NilBridgeCaller) LatestBlockHeight(opts *bind.CallOpts) (*big.Int, error) {
	var out []interface{}
	err := _NilBridge.contract.Call(opts, &out, "latestBlockHeight")

	if err != nil {
		return *new(*big.Int), err
	}

	out0 := *abi.ConvertType(out[0], new(*big.Int)).(**big.Int)

	return out0, err

}

// LatestBlockHeight is a free data retrieval call binding the contract method 0xf3f39ee5.
//
// Solidity: function latestBlockHeight() view returns(uint256)
func (_NilBridge *NilBridgeSession) LatestBlockHeight() (*big.Int, error) {
	return _NilBridge.Contract.LatestBlockHeight(&_NilBridge.CallOpts)
}

// LatestBlockHeight is a free data retrieval call binding the contract method 0xf3f39ee5.
//
// Solidity: function latestBlockHeight() view returns(uint256)
func (_NilBridge *NilBridgeCallerSession) LatestBlockHeight() (*big.Int, error) {
	return _NilBridge.Contract.LatestBlockHeight(&_NilBridge.CallOpts)
}

// LatestStateRoot is a free data retrieval call binding the contract method 0x991beafd.
//
// Solidity: function latestStateRoot() view returns(bytes32)
func (_NilBridge *NilBridgeCaller) LatestStateRoot(opts *bind.CallOpts) ([32]byte, error) {
	var out []interface{}
	err := _NilBridge.contract.Call(opts, &out, "latestStateRoot")

	if err != nil {
		return *new([32]byte), err
	}

	out0 := *abi.ConvertType(out[0], new([32]byte)).(*[32]byte)

	return out0, err

}

// LatestStateRoot is a free data retrieval call binding the contract method 0x991beafd.
//
// Solidity: function latestStateRoot() view returns(bytes32)
func (_NilBridge *NilBridgeSession) LatestStateRoot() ([32]byte, error) {
	return _NilBridge.Contract.LatestStateRoot(&_NilBridge.CallOpts)
}

// LatestStateRoot is a free data retrieval call binding the contract method 0x991beafd.
//
// Solidity: function latestStateRoot() view returns(bytes32)
func (_NilBridge *NilBridgeCallerSession) LatestStateRoot() ([32]byte, error) {
	return _NilBridge.Contract.LatestStateRoot(&_NilBridge.CallOpts)
}

// Owner is a free data retrieval call binding the contract method 0x8da5cb5b.
//
// Solidity: function owner() view returns(address)
func (_NilBridge *NilBridgeCaller) Owner(opts *bind.CallOpts) (common.Address, error) {
	var out []interface{}
	err := _NilBridge.contract.Call(opts, &out, "owner")

	if err != nil {
		return *new(common.Address), err
	}

	out0 := *abi.ConvertType(out[0], new(common.Address)).(*common.Address)

	return out0, err

}

// Owner is a free data retrieval call binding the contract method 0x8da5cb5b.
//
// Solidity: function owner() view returns(address)
func (_NilBridge *NilBridgeSession) Owner() (common.Address, error) {
	return _NilBridge.Contract.Owner(&_NilBridge.CallOpts)
}

// Owner is a free data retrieval call binding the contract method 0x8da5cb5b.
//
// Solidity: function owner() view returns(address)
func (_NilBridge *NilBridgeCallerSession) Owner() (common.Address, error) {
	return _NilBridge.Contract.Owner(&_NilBridge.CallOpts)
}

// VerifyInclusion is a free data retrieval call binding the contract method 0x67c6c8bc.
//
// Solidity: function verifyInclusion(bytes32 leaf, bytes32[] proof) view returns(bool)
func (_NilBridge *NilBridgeCaller) VerifyInclusion(opts *bind.CallOpts, leaf [32]byte, proof [][32]byte) (bool, error) {
	var out []interface{}
	err := _NilBridge.contract.Call(opts, &out, "verifyInclusion", leaf, proof)

	if err != nil {
		return *new(bool), err
	}

	out0 := *abi.ConvertType(out[0], new(bool)).(*bool)

	return out0, err

}

// VerifyInclusion is a free data retrieval call binding the contract method 0x67c6c8bc.
//
// Solidity: function verifyInclusion(bytes32 leaf, bytes32[] proof) view returns(bool)
func (_NilBridge *NilBridgeSession) VerifyInclusion(leaf [32]byte, proof [][32]byte) (bool, error) {
	return _NilBridge.Contract.VerifyInclusion(&_NilBridge.CallOpts, leaf, proof)
}

// VerifyInclusion is a free data retrieval call binding the contract method 0x67c6c8bc.
//
// Solidity: function verifyInclusion(bytes32 leaf, bytes32[] proof) view returns(bool)
func (_NilBridge *NilBridgeCallerSession) VerifyInclusion(leaf [32]byte, proof [][32]byte) (bool, error) {
	return _NilBridge.Contract.VerifyInclusion(&_NilBridge.CallOpts, leaf, proof)
}

// UpdateStateRoot is a paid mutator transaction binding the contract method 0xdb33005a.
//
// Solidity: function updateStateRoot(uint256 blockHeight, bytes32 stateRoot) returns()
func (_NilBridge *NilBridgeTransactor) UpdateStateRoot(opts *bind.TransactOpts, blockHeight *big.Int, stateRoot [32]byte) (*types.Transaction, error) {
	return _NilBridge.contract.Transact(opts, "updateStateRoot", blockHeight, stateRoot)
}

// UpdateStateRoot is a paid mutator transaction binding the contract method 0xdb33005a.
//
// Solidity: function updateStateRoot(uint256 blockHeight, bytes32 stateRoot) returns()
func (_NilBridge *NilBridgeSession) UpdateStateRoot(blockHeight *big.Int, stateRoot [32]byte) (*types.Transaction, error) {
	return _NilBridge.Contract.UpdateStateRoot(&_NilBridge.TransactOpts, blockHeight, stateRoot)
}

// UpdateStateRoot is a paid mutator transaction binding the contract method 0xdb33005a.
//
// Solidity: function updateStateRoot(uint256 blockHeight, bytes32 stateRoot) returns()
func (_NilBridge *NilBridgeTransactorSession) UpdateStateRoot(blockHeight *big.Int, stateRoot [32]byte) (*types.Transaction, error) {
	return _NilBridge.Contract.UpdateStateRoot(&_NilBridge.TransactOpts, blockHeight, stateRoot)
}

// NilBridgeStateRootUpdatedIterator is returned from FilterStateRootUpdated and is used to iterate over the raw logs and unpacked data for StateRootUpdated events raised by the NilBridge contract.
type NilBridgeStateRootUpdatedIterator struct {
	Event *NilBridgeStateRootUpdated // Event containing the contract specifics and raw log

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
func (it *NilBridgeStateRootUpdatedIterator) Next() bool {
	// If the iterator failed, stop iterating
	if it.fail != nil {
		return false
	}
	// If the iterator completed, deliver directly whatever's available
	if it.done {
		select {
		case log := <-it.logs:
			it.Event = new(NilBridgeStateRootUpdated)
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
		it.Event = new(NilBridgeStateRootUpdated)
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
func (it *NilBridgeStateRootUpdatedIterator) Error() error {
	return it.fail
}

// Close terminates the iteration process, releasing any pending underlying
// resources.
func (it *NilBridgeStateRootUpdatedIterator) Close() error {
	it.sub.Unsubscribe()
	return nil
}

// NilBridgeStateRootUpdated represents a StateRootUpdated event raised by the NilBridge contract.
type NilBridgeStateRootUpdated struct {
	BlockHeight *big.Int
	StateRoot   [32]byte
	Raw         types.Log // Blockchain specific contextual infos
}

// FilterStateRootUpdated is a free log retrieval operation binding the contract event 0x81c72bbfba8aa5c196bf46c414765acaeb81b0c575e622425873c001dc6f350d.
//
// Solidity: event StateRootUpdated(uint256 indexed blockHeight, bytes32 stateRoot)
func (_NilBridge *NilBridgeFilterer) FilterStateRootUpdated(opts *bind.FilterOpts, blockHeight []*big.Int) (*NilBridgeStateRootUpdatedIterator, error) {

	var blockHeightRule []interface{}
	for _, blockHeightItem := range blockHeight {
		blockHeightRule = append(blockHeightRule, blockHeightItem)
	}

	logs, sub, err := _NilBridge.contract.FilterLogs(opts, "StateRootUpdated", blockHeightRule)
	if err != nil {
		return nil, err
	}
	return &NilBridgeStateRootUpdatedIterator{contract: _NilBridge.contract, event: "StateRootUpdated", logs: logs, sub: sub}, nil
}

// WatchStateRootUpdated is a free log subscription operation binding the contract event 0x81c72bbfba8aa5c196bf46c414765acaeb81b0c575e622425873c001dc6f350d.
//
// Solidity: event StateRootUpdated(uint256 indexed blockHeight, bytes32 stateRoot)
func (_NilBridge *NilBridgeFilterer) WatchStateRootUpdated(opts *bind.WatchOpts, sink chan<- *NilBridgeStateRootUpdated, blockHeight []*big.Int) (event.Subscription, error) {

	var blockHeightRule []interface{}
	for _, blockHeightItem := range blockHeight {
		blockHeightRule = append(blockHeightRule, blockHeightItem)
	}

	logs, sub, err := _NilBridge.contract.WatchLogs(opts, "StateRootUpdated", blockHeightRule)
	if err != nil {
		return nil, err
	}
	return event.NewSubscription(func(quit <-chan struct{}) error {
		defer sub.Unsubscribe()
		for {
			select {
			case log := <-logs:
				// New log arrived, parse the event and forward to the user
				event := new(NilBridgeStateRootUpdated)
				if err := _NilBridge.contract.UnpackLog(event, "StateRootUpdated", log); err != nil {
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
func (_NilBridge *NilBridgeFilterer) ParseStateRootUpdated(log types.Log) (*NilBridgeStateRootUpdated, error) {
	event := new(NilBridgeStateRootUpdated)
	if err := _NilBridge.contract.UnpackLog(event, "StateRootUpdated", log); err != nil {
		return nil, err
	}
	event.Raw = log
	return event, nil
}
