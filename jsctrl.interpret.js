#!/usr/bin/env node

// returns a function which, when called, will interpret f with env as its enclosing environment
function __interpreter(n, outerEnv, program) {
	var f = program[n]
	return function self() {
		if (f.blocks === null) {
			throw new Error("Function uses unsupported feature")
		}
		// console.log(n)
		var env = Object.create(null)
		env['@outer'] = outerEnv
		f.variables.forEach(function(v) {
			env[v] = undefined
		})
		var locals = []
		locals[0] = this;
		locals[1] = self;
		locals[2] = arguments;
		for (var i=0; i<f.num_parameters; i++) {
			locals[i+3] = arguments[i];
		}
		function getEnvWithVar(v) {
			var e = env
			while (!(v in e) && '@outer' in e) {
				e = e['@outer']
			}
			return e
		}
		function resolvePrty(x) {
			if (typeof x === 'number') {
				return String(locals[x])
			} else {
				return x
			}
		}
		function lookupLocal(x) {
			return locals[x]
		}
		var bindex = 0
		while (true) {
			var block = f.blocks[bindex]
			for (var sti=0; sti<block.statements.length; sti++) {
				var stmt = block.statements[sti];
				switch (stmt.type) {
					case 'read-var':
						var e = getEnvWithVar(stmt.var)
						locals[stmt.dst] = e[stmt.var]
						break;
					case 'write-var':
						var e = getEnvWithVar(stmt.var)
						e[stmt.var] = locals[stmt.src]
						break;
					case 'assign':
						locals[stmt.dst] = locals[stmt.src]
						break;
					case 'load':
						var str = resolvePrty(stmt.prty)
						locals[stmt.dst] = locals[stmt.object][str]
						break;
					case 'store':
						var str = resolvePrty(stmt.prty)
						locals[stmt.object][str] = locals[stmt.src]
						break;
					case 'const':
						locals[stmt.dst] = stmt.value;
						break;
					case 'create-object':
						var obj = {}
						stmt.properties.forEach(function(prty) {
							if (prty.type === 'value') {
								obj[prty.name] = locals[prty.value]
							} else {
								Object.defineProperty(obj, prty.name, {
									configurable: true,
									enumerable: true,
									get: prty.get && locals[prty.get],
									set: prty.set && locals[prty.set]
								})
							}
						})
						locals[stmt.dst] = obj
						break;
					case 'create-array':
						var array = []
						for (var i = 0; i < stmt.elements.length; i++) {
							if (stmt.elements[i] === null)
								continue
							array[i] = locals[stmt.elements[i]]
						};
						locals[stmt.dst] = array
						break;
					case 'create-function':
						locals[stmt.dst] = __interpreter(stmt.function, env, program)
						break;
					case 'call-method':
						var object = locals[stmt.object]
						var prty = resolvePrty(stmt.prty)
						var fun = object[prty]
						var args = stmt.arguments.map(lookupLocal)
						locals[stmt.dst] = fun.apply(object, args)
						break;
					case 'call-function':
						var fun = locals[stmt.function]
						var args = stmt.arguments.map(lookupLocal)
						locals[stmt.dst] = fun.apply(undefined, args)
						break;
					case 'call-constructor':
						var fun = locals[stmt.function]
						var args = stmt.arguments.map(lookupLocal)
						var base = Object.create(fun.prototype)
						var result = fun.apply(base, args)
						if (result !== null && (typeof result === 'object' || typeof result === 'function')) {
							locals[stmt.dst] = result
						} else {
							locals[stmt.dst] = base
						}
						break;
					case 'unary':
						var arg = locals[stmt.argument]
						var result;
						switch (stmt.operator) {
							case '+': result = +arg; break;
							case '-': result = -arg; break;
							case '!': result = !arg; break;
							case '~': result = ~arg; break;
							case 'typeof': result = typeof arg; break;
							case 'void': result = void arg; break;
							case '++': result = Number(arg) + 1; break;
							case '--': result = Number(arg) - 1; break;
							default: throw new Error("Unsupported unary operator: " + stmt.operator)
						}
						locals[stmt.dst] = result
						break;
					case 'binary':
						var left = locals[stmt.left]
						var right = locals[stmt.right]
						var result;
						switch (stmt.operator) {
							case '==': result = left == right; break;
							case '!=': result = left != right; break; // TODO: remove negated variants from CFG?
							case '===': result = left === right; break;
							case '!==': result = left !== right; break;
							case '<': result = left < right; break;
							case '<=': result = left <= right; break;
							case '>': result = left > right; break;
							case '>=': result = left >= right; break;
							case '<<': result = left << right; break;
							case '>>': result = left >> right; break;
							case '>>>': result = left >>> right; break;
							case '+': result = left + right; break;
							case '-': result = left - right; break;
							case '*': result = left * right; break;
							case '/': result = left / right; break;
							case '%': result = left % right; break;
							case '|': result = left | right; break;
							case '^': result = left ^ right; break;
							case '&': result = left & right; break;
							case 'in': result = left in right; break;
							case 'instanceof': result = left instanceof right; break;
							default: throw new Error("Unsupported binary operator: " + stmt.operator)
						}
						locals[stmt.dst] = result
						break;
					default:
						throw new Error("statement type: " + stmt.type)
				}
			}
			switch (block.jump.type) {
				case 'return':
					if (block.jump.value === null)
						return
					else
						return locals[block.jump.value]
				case 'throw':
					throw locals[block.jump.value];
				case 'goto':
					bindex = block.jump.target
					break;
				case 'if':
					bindex = locals[block.jump.condition] ? block.jump.then : block.jump.else
					break;
				default:
					throw new Error("Invalid jump")
			}
		}
	}
}

module.exports = __interpreter


// -------------------
//     Entry Point
// -------------------

function __main() {
	var esprima = require('esprima')
	var jsctrl = require('./jsctrl')
	var fs = require('fs')
	var program = require('commander')

	program.usage('FILE.js [options]')
	program.parse(process.argv)
	if (program.args.length < 1) {
		program.help()
	}

	var file = program.args[0]
	var text = fs.readFileSync(file, 'utf8')
	var ast = esprima.parse(text)
	var cfg = jsctrl(ast)

	var executor = __interpreter(0, this, cfg)

	executor.call(this)
}

if (require.main === module) {
	__main();
}