/*
	interface State {
		this : Value
		
	}
	interface Terminator {
		type: 'break' | 'continue' | 'return'
		label?: string
		value?: Value
	}
	interface StmtState {
		terminator? : Terminator
		state : State
	}
	type States = State[]

	interface Cond {
		whenTrue?: ExpState
		whenFalse?: ExpState
	}
	interface ExpState {
		value : Value
		state : State
	}
*/

Array.prototype.pushs = function(arr) {
	var len = arr.length;
	for (var i=0; i<len; ++i) {
		this.push(arr[i]);
	}
}

function stateEq(x,y) {
	// todo
}

function fixpoint(initial, eq, fn) {
	var st;
	fn(initial, function(st) {
		if (eq(initial,st))
			return st;
		return fixpoint(st, eq, fn)
	})
}

function visitStmtx(node, sts) {
	var results = []
	sts.forEach(function(st) {
		results.pushs(visitStmt(node, st))
	})
	return results
}

function visitStmtBlock(stmts, st) {
	var sts = [{state:st}]
	var abnormalTerm = []
	for (var i=0; i<stmts.length; i++) {
		var next = []
		sts.forEach(function(st) {
			var stmtSts = visitStmt(stmts[i], st.state)
			stmtSts.forEach(function(st2) {
				if (st2.terminator)
					abnormalTerm.push(st2)
				else
					next.push(st2)
			})
		})
		sts = next
	}
	return sts.concat(abnormalTerm);
}

function visitStmt(node, st) {
	switch (node.type) {
		case 'EmptyStatement':
			return [ { state:st } ];
		case 'BlockStatement':
			return visitStmtBlock(node.body, st)
		case 'ExpressionStatement':
			return visitExp(node.expression, st).map(function(er) {
				return {
					state: er.state
				}
			});
		case 'IfStatement':
			var cond = visitCond(node.test, st);
			var results = []
			cond.whenTrue.forEach(function(er) {
				results.pushs(visitStmt(node.consequent, er.state))
			})
			cond.whenFalse.forEach(function(er) {
				if (node.alternate) {
					results.pushs(visitStmt(node.alternate, er.state))
				} else {
					results.pushs(er.state)
				}
			})
			return results
		case 'LabeledStatement':
			var memo = getMemo(node)
			var h = hashState(st)
			if (h in memo) {
				return memo[h];
			}
			memo[h] = [];
			var results = [];
			visitStmt(node.body, st).forEach(function(r) {
				if (r.terminator && r.terminator.label === node.label.name) {
					if (r.terminator.type === 'continue') {
						// note: for statement and for-in statement will override this behaviour
						results.pushs(visitStmt(node, r.state))
					} else {
						results.push({state:r.state}) // clear the terminator flag
					}
				} else {
					results.push(r) // preserve possible terminator flag
				}
			})
			// TODO: remove duplicates from results?
			memo[h] = results;
			return results;
		case 'BreakStatement':
			return [{
				state: st, 
				terminator: {
					type: 'break', 
					label: node.label ? node.label.name : '*'
				}
			}]
		case 'ContinueStatement':
			return [{
				state: st,
				terminator: {
					type: 'continue',
					label: node.label ? node.label.name : '*'
				}
			}]
		case 'WithStatement':
			throw new Error("With statement not supported");
		case 'SwitchStatement':
			var result = []
			visitExp(node.discriminant, st).forEach(function(er) {
				var caseBranches = [er.state]
				var fallBranches = []
				for (var i=0; i<node.cases.length; i++) {
					var caze = node.cases[i];
					var nextCase = []
					var nextFall = []
					var entryStates;
					if (caze.test) {
						entryStates = []
						caseBranches.forEach(function(caseBranch) {
							var cond = visitStrictEqCond(caze.test, er.value, caseBranch)
							entryStates.pushs(cond.whenEq)
							nextCase.pushs(cond.whenNeq)
						})
					} else { // default clause
						entryStates = [caseBranch];
					}
					entryStates = entryStates.concat(fallBranches)
					entryStates.forEach(function(st) {
						visitStmtBlock(caze.consequent, st).forEach(function(r) {
							if (r.terminator && r.terminator.type === 'break' && r.terminator.label === '*') {
								result.push({state:r.state}) // clear terminator flag
							} else if (r.terminator) {
								result.push(r)
							} else {
								nextFall.push(r) // fall into next case clause
							}
						})
					})
					caseBranch = nextCase
					fallBranches = nextFall
				}
				result.pushs(caseBranch)
			})
			return result
		case 'ReturnStatement':
			if (node.argument) {
				return visitExp(node.argument, st).map(function(er) {
					return {
						terminator: {type: 'return', value:er.value},
						state: er.state
					}
				})
			} else {
				return [{
					terminator: {type: 'return', value:{type:'void'}},
					state: st
				}]
			}
		case 'ThrowStatement':
			return []
		case 'TryStatement':
			throw new Error("Try statement not supported")
		case 'WhileStatement':
			var memo = getMemo(node)
			var h = hashState(st)
			if (h in memo) {
				return memo[h]
			}
			memo[h] = []
			var result = []
			var cond = visitCond(node.test, st)
			cond.whenTrue.forEach(function(er) {
				visitStmt(node.body, er.state).forEach(function(r) {
					if (r.terminator && r.terminator.label === '*') {
						if (r.terminator.type === 'continue') {
							result.pushs(visitStmt(node, r.state))
						} else {
							result.push({state:r.state})
						}
					} else if (r.terminator) {
						result.push(r)
					} else {
						result.pushs(visitStmt(node, r.state))
					}
				})
			})
			cond.whenFalse.forEach(function(er) {
				result.push(er.state)
			})
			memo[h] = result
			return result
		case 'DoWhileStatement':
			var memo = getMemo(node)
			var h = hashState(st)
			if (h in memo) {
				return memo[h]
			}
			memo[h] = []
			var result = []
			visitStmt(node.body, st).forEach(function(r) {
				if (r.terminator && r.terminator.label === '*') {
					if (r.terminator.type === 'continue') {
						result.pushs(visitStmt(node, r.state))
					} else {
						result.push({state:r.state})
					}
				} else if (r.terminator) {
					result.push(r)
				} else {
					var cond = visitCond(node.test, r.state)
					cond.whenTrue.forEach(function(er) {
						result.pushs(visitStmt(node, {state:er.state}))
					})
					cond.whenFalse.forEach(function(er) {
						result.push({state:er.state})
					})
				}
			})
			return result
		/* TODO rest of statements */
	}
}

function visitExpx(node, sts) {
	var result = []
	sts.forEach(function(st) {
		visitExp(node,st).forEach(function(er) {
			result.push(er)
		})
	})
	return result
}

function visitExp(node, st) {
	switch (node.type) {
		case 'ThisExpression':
			return [{
				state: st,
				value: st.this
			}]
		case 'ArrayExpression':
			if (node.elements.length === 0) {
				return [{
					state: st,
					value: {
						type:'reference', 
						name:'Array', 
						typeArguments: [{ type:'abstract', id:getNodeId(node) }]
					}
				}]
			}
			var states = [{
				state: st,
				members: []
			}]
			node.elements.forEach(function(elm) {
				var next = []
				states.forEach(function(stx) {
					visitExp(elm, stx.state).forEach(function(er) {
						next.push({
							state: er.state,
							members: stx.members.concat([er.value])
						})
					})
				})
				states = next
			})
			return states.map(function(stx) {
				return {
					state: stx.state,
					value: {
						type:'reference', 
						name:'Array', 
						typeArguments: [ bestCommonType(stx.members) ]
					}
				}
			}) // todo: compress here?
		case 'ObjectExpression':
			if (node.properties.length === 0) {
				return [{
					state: st,
					value: {
						type: 'abstract', 
						id:getNodeId(node)
					}
				}]
			}
			var prtys = new Map
			var states = [{
				state: st,
				properties: new Map
			}]
			node.properties.forEach(function(prty) {
				var next = []
				var name = prty.key.type === 'Identifier' ? prty.key.name : String(prty.key.value);
				if (prty.kind === 'get' || prty.kind === 'set')  {
					throw new Error("Getters and setters not supported")
				} else {
					states.forEach(function(stx) {
						visitExp(prty.value, stx.state).forEach(function(er) {
							var prtys = stx.properties.clone()
							prtys.put(name, er.value)
							next.push({
								state: er.state,
								properties: prtys
							})
						})
					})
				}
				states = next
			})
			return states.map(function(stx) {
				return {
					state: stx.state,
					value: {
						type: 'object',
						properties: stx.properties.json(),
						calls: [],
						stringIndexer: null,
						numberIndexer: null
					}
				}
			})
		case 'FunctionExpression':
			return [{
				state: st, // todo: use abstract value + function body as abstract state?
				value: { type:'function', id:getNodeId(node) }
			}]
		case 'SequenceExpression':
			var states = [{state:st, value:null}]
			node.expressions.forEach(function(exp) {
				var next = []
				states.forEach(function(st) {
					visitExp(exp, st.state).forEach(function(er) {
						next.push(er)
					})
				})
				states = next
			})
			return states
	}
}

// When an abstract value is a function pointer, the function must share environment objects with the active environment.
// Two environments "share environment objects" iff their environment objects are the same for all common ancestor scopes.



function checkType(node, types) {
	switch  (node.type) {
		case 'Assignment':
	}
}
