jsctrl: Control-Flow Graphs for JavaScript
==========================================

jsctrl produces control-flow graphs for a subset of JavaScript.

Usage
-----
From node.js:

	jsctrl = require('jsctrl')
	var ast = esprima.parse(...)
	var cfg = jsctrl(ast)

Visualizing control-flow graphs from the command-line (replace `xdg-open` with `open` on Mac):

	./jsctrl.js FILE.js --dot | dot -Tpng -o cfg.png
	xdg-open cfg.png

Alternatively, pass the flag `--pretty` to see a pretty-printed JSON output of the CFG.

Missing Language Constructs
---------------------------
For-in loops, try-catch blocks, with statements cannot be represented in this CFG format; functions using these features will have their block array set to null.


API
===

The module `jsctrl` is a function which takes an Esprima AST and returns a control-flow graph, according to the type schema below. Note that the AST will be heavily modified in the process.

Type Schema
-----------

The following shows the structure of the control-flow graph:

	type var = number    // temporary variable
	type fun = number    // index of function
	type label = number  // index of block

	type Stmt = 
	 | { type: 'read-var', var: string, dst: var }
	 | { type: 'write-var', var: string, src: var }
	 | { type: 'assign', src: var, dst: var }
	 | { type: 'load', object: var, prty: PrtyRef, dst: var }
	 | { type: 'store', object: var, prty: PrtyRef, src: var }
	 | { type: 'const', dst: var, value: string | number | boolean | null | undefined }
	 | { type: 'create-object', properties: Property[] }
	 | { type: 'create-array', elements: Element[] }
	 | { type: 'create-function', function: fun, dst: var }
	 | { type: 'call-method', object: var, prty: PrtyRef, arguments: var[] }
	 | { type: 'call-function', function: var, arguments: var[] }
	 | { type: 'call-constructor', function: var, arguments: var[] }
	 | { type: 'unary', operator: string, argument: var }
	 | { type: 'binary', operator: string, left: var, right: var }

	type Jump = 
	 | { type: 'goto'; target: label }
	 | { type: 'if'; condition: var; then: label; else: label }
	 | { type: 'return', value: var | null, implicit: boolean }
	 | { type: 'throw', value: var }

	type Block = { statements: Stmt[]; jump: Jump }

	type Element = number | null

	type Property = ValueProperty | AccessorProperty
	type ValueProperty = {
		type: 'value',
		name: string,
		value: var
	},
	type AccessorProperty = {
		type: 'accessor',
		name: string,
		get: var | null,
		set: var | null
	}
	
	type PrtyRef = var | string

	type Function = {
		num_parameters: number
		variables: string[]
		blocks: Block[] | null
	}

	type Program = Function[]


Operators
---------
Operators are the string representation of the operator, such as "+" or "-". The unary operator "++" (and "--") does not modify its operand (like in JavaScript); instead it coerces its operand to a number and returns that value plus/minus one.

Temporary Variables
-------------------
The type `var` above denotes temporary variables. Temporary variables are numbered from 0 and upwards and are generally condensed towards zero, but with no particular guarantee regarding compactness. The statements read-var and write-var are used to move values between temporary variables and program variables.

Temporary variables cannot be captured in a closure, and their namespace is separate for each function (i.e. variable N in one function is unrelated to variable N in another function). When possible, program variables are translated into temporary variables to assist subsequent analysis.

Special variable numbers:

 - variable 0 is reserved for the value of `this`, 
 - variable 1 is reserved for the function instance,
 - variable 2 is reserved for the arguments array,
 - variables 3 up to N+3 are reserved for parameters, where N is the number of parameters.

PrtyRef
-------
The type PrtyRef used in load, store, and call-method statements can either refer directly to a property name (string) or refer to a temporary variable (number). When it refers to a temporary variable, the value held in that variable determines the property being accessed (i.e. corresponding to expressions on form `x[e]`).

