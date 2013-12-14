/*
	interface State {
		// ???
	}
	interface Terminator {
		type: 'break' | 'continue' | 'return'
		label?: string
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
			return st;
		case 'BlockStatement':
			return visitStmtBlock(node.body, st)
		case 'ExpressionStatement':
			return visitExp(node.expression, st).map(function(er) {
				return {
					state: er.state
				}
			});
		case 'IfStatement':
			var conds = visitCond(node.test, st);
			var results = []
			conds.forEach(function(cond) {
				if (cond.whenTrue) {
					results.pushs(visitStmt(node.consequent, cond.whenTrue.state))
				}
				if (cond.whenFalse) {
					if (node.alternate) {
						results.pushs(visitStmt(node.alternate, cond.whenFalse.state))
					} else {
						results.pushs(cond.whenFalse.state)
					}
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
				if (r.terminator && (r.terminator.label === node.label.name || r.terminator.label === '*')) {
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
			return {
				state: st, 
				terminator: {
					type: 'break', 
					label: node.label ? node.label.name : '*'
				}
			}
		case 'ContinueStatement':
			return {
				state: st,
				terminator: {
					type: 'continue',
					label: node.label ? node.label.name : '*'
				}
			}
		case 'WithStatement':
			throw new Error("With statement not supported");
		case 'SwitchStatement':
			var result = []
			var er = visitExp(node.discriminant)
			var caseBranch = er.state
			var nextCaseBranch = []
			for (var i=0; i<node.cases.length; i++) {
				var caze = node.cases[i];
				var inSt;
				var outSt;
				if (caze.test) {
					var cond = visitStrictEqCond(caze.test, er.value, caseBranch)
					inSt = cond.whenEq;
					outSt = cond.whenNeq;
				} else { // default clause
					inSt = [caseBranch];
					outSt = [];
				}
				inSt.forEach(function(st) {
					visitStmtBlock(caze.consequent, st).forEach(function(r) {
						if (r.terminator && r.terminator.type === 'break' && r.terminator.label === '*') {
							result.push({state:r.state}) // clear terminator flag
						} else {

						}
					})
				})
				inSt.map(visitStmtBlock.fill(caze.consequent))
				visitStmtBlock(caze.consequent, inSt)
			})
	}
}

function checkType(node, types) {
	switch  (node.type) {
		case 'Assignment':
	}
}
