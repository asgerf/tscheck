var esprima = require('esprima');
require('sugar');

function labelJumpTargets(ast) {
	var breakTargets = []
	var continueTargets = []
	var labels = {}
	function visit(node) {
		function visitChildren() { 
			children(node).forEach(visit)
		}
		switch (node.type) {
			case 'BreakStatement':
				if (!node.label) {
					breakTargets.last().$break_target = true
				} else {
					labels[node.label].$break_target = true
				}
				visitChildren()
				break;
			case 'ContinueStatement':
				if (!node.label) {
					continueTargets.last().$continue_target = true
				} else {
					labels[node.label].$continue_target = true
				}
				visitChildren()
				break;
			case 'LabeledStatement':
				var old_value = labels[node.label]
				labels[node.label] = node
				visitChildren()
				labels[node.label] = old_value
				break;
			case 'ForStatement':
			case 'ForInStatement':
			case 'WhileStatement':
			case 'DoWhileStatement':
				breakTargets.push(node)
				continueTargets.push(node)
				visitChildren()
				breakTargets.pop()
				continueTargets.pop()
				break;
			case 'SwitchStatement':
				breakTargets.push(node)
				visitChildren()
				breakTargets.pop()
				break;
			default:
				visitChildren();
		}
	}
	visit(ast)
}

/*
	interface info {
		next_label: int
		break?: int
		continue?: int
	}
*/

function labeledStmt(label, stmt) {
	if (label === null)
		return stmt
	else
		return { type: 'LabeledStatement', label: label, body: stmt }
}
function block(stmts) {
	stmts = stmts.filter(function(stmt) { return stmt.type !== 'EmptyStatement '})
	if (stmts.length === 0)
		return { type: 'EmptyStatement' }
	else if (stmts.length === 1)
		return stmts[0]
	else
		return { type: 'BlockStatement', body: stmts }
}

function normalize(ast) {
	var next_label = 1
	var breaks = []
	var continues = []
	var labeled_continues = {}
	function makeLabels(node, fn) {
		var b = null, c = null;
		if (node.$break_target) {
			breaks.push(b = '$' + next_label++)
		}
		if (node.$continue_target) {
			continues.push(c = '$' + next_label++)
		}
		var r = fn(b,c)
		if (node.$break_target) {
			breaks.pop()
		}
		if (node.$continue_target) {
			continues.pop()
		}
		return r
	}
	function visit(node) {
		switch (node.type) {
			case 'ForStatement':
				return makeLabels(node, function(b,c) {
					var init;
					if (node.init == null)
						init = { type: 'EmptyStatement' }
					else if (node.init.type === 'VariableDeclaration')
						init = visit(node.init)
					else
						init = { type: 'ExpressionStatement', expression: visit(node.init) }
					return block([
						init,
						labeledStmt(b, {
							type: 'WhileStatement',
							test: node.test ? visit(node.test) : { type: 'Literal', value: true },
							body: labeledStmt(c, visit(node.body))
						})
					])
				})
			case 'WhileStatement':
				return makeLabels(node, function(b,c) {
					return labeledStmt(b, {
						type: 'WhileStatement',
						test: visit(node.test),
						body: labeledStmt(c, visit(node.body))
					})
				})
			case 'DoWhileStatement':
				return makeLabels(node, function(b,c) {
					return labeledStmt(b, {
						type: 'DoWhileStatement',
						body: labeledStmt(c, visit(node.body)),
						test: visit(node.test)
					})
				})
			case 'ForInStatement':
				
			case 'LabeledStatement':
				if (node.label[0] === '$') {
					node.label = '$' + node.label;
				}
				if (node.$continue_target) {
					var old = labeled_continues[node.label]
					var b = node.$break_target ? node.label : null;
					var c = labeled_continues[node.label] = '$' + next_label++
					var r = labeledStmt(b, {
						type: 'WhileStatement',
						test: { type: 'Literal', value: true },
						body: 
							labeledStmt(c, 
								block([
									visit(node.body),
									{ type: 'BreakStatement', label: b }
								])
							)
					})
					labeled_continues[node.label] = old
					return r;
				} else {
					return node; // only used for labeled break, no rewrite necessary
				}
			case 'BreakStatement':
				if (node.label) {
					if (node.label[0] === '$')
						node.label = '$' + node.label
				} else {
					node.label = breaks.last()
				}
				return node;
			case 'ContinueStatement':
				if (node.label) {
					if (node.label[0] === '$')
						node.label = '$' + node.label
					node.type = 'BreakStatement';
					node.label = labeled_continues[node.label]
				} else {
					node.type = 'BreakStatement';
					node.label = continues.last()
				}
				return node;

		}
	}
}
