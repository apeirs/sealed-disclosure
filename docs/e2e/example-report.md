Component: ExampleVault.withdraw (testnet demo contract)
Steps: call withdraw(amount) twice in one block from a contract whose receive() re-enters.
Impact: the second call reads the balance before the first one is written, so a holder can take twice their deposit.
Fix: move the balance write above the external call (checks-effects-interactions) or add a reentrancy guard.
