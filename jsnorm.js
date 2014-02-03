#!/usr/bin/env node
var esprima = require('esprima');
var escodegen = require('escodegen');
require('sugar');


// Returns the given AST node's immediate children as an array.
// Property names that start with $ are considered annotations, and will be ignored.
function children(node) {
    var result = [];
    for (var k in node) {
        if (!node.hasOwnProperty(k))
            continue;
        if (k[0] === '$')
            continue;
        var val = node[k];
        if (!val)
            continue;
        if (typeof val === "object" && typeof val.type === "string") {
            result.push(val);
        }
        else if (val instanceof Array) {
            for (var i=0; i<val.length; i++) {
                var elm = val[i];
                if (typeof elm === "object" && typeof elm.type === "string") {
                    result.push(elm);
                }
            }
        } 
    }
    return result;
}

/*
	Adds $break_target and $continue_target fields to the following nodes
	- LabeledStatement
	- ForStatement
	- ForInStatement
	- WhileStatement
	- DoWhileStatement
	- SwitchStatement
*/
function labelJumpTargets(ast) {
	var breakTargets = []
	var continueTargets = []
	var labels = {}
	var labelSet = []
	function visit(node) {
		function visitChildren() { 
			var myLabels = labelSet
			labelSet = null
			myLabels && myLabels.forEach(function(l) {
				labels[l] = node
			})
			children(node).forEach(visit)
			myLabels && myLabels.forEach(function(l) {
				delete labels[l]
			})
		}
		switch (node.type) {
			case 'BreakStatement':
				if (!node.label) {
					breakTargets.last().$break_target = true
				} else {
					labels[node.label.name].$break_target = true
				}
				visitChildren()
				break;
			case 'ContinueStatement':
				if (!node.label) {
					continueTargets.last().$continue_target = true
				} else {
					labels[node.label.name].$continue_target = true
				}
				visitChildren()
				break;
			case 'LabeledStatement':
				labelSet = labelSet || []
				labelSet.push(node.label.name)
				if (node.body.type === 'ForStatement' || 
					node.body.type === 'ForInStatement' || 
					node.body.type === 'WhileStatement' || 
					node.body.type === 'DoWhileStatement' || 
					node.body.type === 'SwitchStatement' ||
					node.body.type === 'LabeledStatement') {
					// add to label set of child and handle it there
					labelSet.push(node.label.name)
					visit(node.body, labelSet)
				} else {
					visitChildren()
				}
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

// The statement `label: stmt` unless label is null, in which case stmt is returned
function labeledStmt(label, stmt) {
	if (label === null)
		return stmt
	else
		return { type: 'LabeledStatement', label: { type: 'Identifier', name: label }, body: stmt }
}

// The given array of statements as a block statement. Empty statements will be excluded
// from the block. If the resulting block is empty, an empty statement is returned instead,
// and if the block consists of only one statement, that statement is returned (not as a block)
function block(stmts) {
	stmts = stmts.filter(function(stmt) { return stmt.type !== 'EmptyStatement '})
	if (stmts.length === 0)
		return { type: 'EmptyStatement' }
	else if (stmts.length === 1)
		return stmts[0]
	else
		return { type: 'BlockStatement', body: stmts }
}

// Normalizes the given AST by eliminating the following control structures:
// - Continue statements
// - Unlabeled break statements
// - For statements
// - Switch statements
//
// Notably, the following control structures are still in the AST (and will be inserted in place of those that were eliminated):
// - Labeled breaks
// - Labeled statements (only targeted by breaks)
// - For-in statements
// - While statements
// - Do-while statements
function normalize(ast) {
	labelJumpTargets(ast)
	var next_var = 1
	var next_label = 1
	var breaks = []
	var continues = []
	var labeled_continues = {}
	var labeled_breaks = {}
	var label_set = []
	function makeLabels(node, fn) {
		var b = null, c = null;
		var extra_labels = label_set
		label_set = []
		if (node.$break_target) {
			breaks.push(b = '$' + next_label++)
			extra_labels.forEach(function(l) {
				labeled_breaks[l] = b
			})
		}
		if (node.$continue_target) {
			continues.push(c = '$' + next_label++)
			extra_labels.forEach(function(l) {
				labeled_continues[l] = c
			})
		}
		var r = fn(b,c)
		if (node.$break_target) {
			breaks.pop()
			extra_labels.forEach(function(l) {
				labeled_breaks[l] = null
			})
		}
		if (node.$continue_target) {
			continues.pop()
			extra_labels.forEach(function(l) {
				labeled_continues[l] = null
			})
		}
		return r
	}
	function visitX(node, parent) {
		function visit(n) {
			return visitX(n, node)
		}
		switch (node.type) {
			case 'ForStatement':
				return makeLabels(node, function(b,c) {
					var init;
					if (node.init === null)
						init = { type: 'EmptyStatement' }
					else if (node.init.type === 'VariableDeclaration')
						init = visit(node.init)
					else
						init = { type: 'ExpressionStatement', expression: visit(node.init) }
					var update;
					if (node.update === null)
						update = { type: 'EmptyStatement' }
					else
						update = { type: 'ExpressionStatement', expression: visit(node.update) }
					return block([
						init,
						labeledStmt(b, {
							type: 'WhileStatement',
							test: node.test ? visit(node.test) : { type: 'Literal', value: true },
							body: block([
								labeledStmt(c, visit(node.body)),
								update])
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
				return makeLabels(node, function(b,c) {
					return labeledStmt(b, {
						type: 'ForInStatement',
						left: visit(node.left),
						right: visit(node.right),
						body: labeledStmt(c, visit(node.body))
					})
				})
			case 'LabeledStatement':
				if (node.label.name[0] === '$') {
					node.label.name = '$' + node.label.name;
				}
				if (node.body.type === 'ForStatement' || 
					node.body.type === 'ForInStatement' || 
					node.body.type === 'WhileStatement' || 
					node.body.type === 'DoWhileStatement' || 
					node.body.type === 'SwitchStatement' ||
					node.body.type === 'LabeledStatement') {
					// add to label set and let child handle it
					label_set.push(node.label.name)
					return visit(node.body)
				} else {
					node.body = visit(node.body)
					return node; // only used for labeled break, no rewrite necessary
				}
			case 'SwitchStatement':
				return makeLabels(node, function(b,c) {
					var casevar = '$' + next_var++;
					var discvar = '$' + next_var++;
					var stmts = []
					stmts.push({
						type: 'VariableDeclaration',
						kind: 'var',
						declarations: [{
							type: 'VariableDeclarator',
							id: { type: 'Identifier', name: casevar },
							init: { type: 'Literal', value: false }
						}, {
							type: 'VariableDeclarator',
							id: { type: 'Identifier', name: discvar },
							init: visit(node.discriminant)
						}]
					})
					var defaultReached = false;
					node.cases.forEach(function(caze) {
						if (caze.test) {
							stmts.push({
								type: 'ExpressionStatement',
								expression: {
									type: 'AssignmentExpression',
									operator: '=',
									left: { type: 'Identifier', name: casevar },
									right: {
										type: 'LogicalExpression',
										operator: '||',
										left: { type: 'Identifier', name: casevar },
										right: {
											type: 'BinaryExpression',
											operator: '===',
											left: { type: 'Identifier', name: discvar },
											right: visit(caze.test)
										}
									}
								}
							})
						} else {
							defaultReached = true
						}
						if (caze.consequent.length > 0) {
							if (defaultReached) {
								stmts.push(block(caze.consequent.map(visit)))
							} else {
								stmts.push({
									type: 'IfStatement',
									test: { type: 'Identifier', name: casevar },
									consequent: block(caze.consequent.map(visit)),
									alternate: null
								})
							}
						}
					})
					return labeledStmt(b, block(stmts))
				})
			case 'BreakStatement':
				if (node.label) {
					if (node.label.name[0] === '$')
						node.label.name = '$' + node.label.name
					node.label.name = labeled_breaks[node.label.name] || node.label.name
				} else {
					node.label = { type: 'Identifier', name: breaks.last() }
				}
				return node;
			case 'ContinueStatement':
				if (node.label) {
					if (node.label.name[0] === '$')
						node.label.name = '$' + node.label.name
					node.type = 'BreakStatement';
					node.label.name = labeled_continues[node.label.name]
				} else {
					node.type = 'BreakStatement';
					node.label = { type: 'Identifier', name: continues.last() }
				}
				return node;
			case 'Identifier':
				var isVariableName = true;
				switch (parent.type) {
			        case 'MemberExpression':
			            if (!parent.computed && parent.property === node) {
			            	isVariableName = false;
			            }
			            break;
			        case 'Property':
			        	if (parent.key === node) {
			        		isVariableName = false;
			        	}
			            break;
			        case 'BreakStatement':
			        case 'ContinueStatement':
			        case 'LabeledStatement':
			        	isVariableName = false;
			            break;
				}
				if (isVariableName && node.name[0] === '$') {
					node.name = '$' + node.name; // disambiguate variable name
				}
				return node;
			default:
				// recurse on all children
				for (var k in node) {
					if (k[0] === '$')
						continue;
					var v = node[k]
					if (v instanceof Array) {
						for (var i=0; i<v.length; i++) {
							var vi = v[i];
							if (vi && vi.type) {
								v[i] = visit(vi)
							}
						}
					} else if (v && v.type) {
						node[k] = visit(v)
					}
				}
				return node
		}
	}
	return visitX(ast)
}


module.exports = normalize

// ===========================
//  Entry Point
// ===========================
function censorAnnotations(k,v) {
	if (k && k[0] === '$')
		return undefined
	else
		return v;
}

function main() {
	var program = require('commander');
	var fs = require('fs')
	var util = require('util')

	program.option('--struct', 'Print AST structure instead of source code')
	program.option('--json', 'Print AST structure as JSON')
	program.usage('FILE.js [options]')
	program.parse(process.argv)
	if (program.args.length < 1)
		program.help()

	var text = fs.readFileSync(program.args[0], 'utf8')
	var ast = esprima.parse(text)
	ast = normalize(ast)
	if (program.json) {
		console.log(JSON.stringify(ast, censorAnnotations))
	} else if (program.struct) {
		console.log(util.inspect(ast, {depth:null}))
	} else {
		console.log(escodegen.generate(ast))
	}
}

if (require.main === module) {
	main();
}