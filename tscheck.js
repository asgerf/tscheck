#!/usr/bin/env node
var fs = require('fs');
var tscore = require('./tscore');
require('sugar');
var Map = require('./map');
var util = require('util');
var esprima = require('esprima');

var program = require('commander');
program.usage("FILE.jsnap FILE.d.ts [options]")
program.option('--compact', 'Report at most one violation per type path')
	   .option('--suggest', 'Suggest additions to the interface')
	   .option('--coverage', 'Print declaration file coverage')
	   .option('--no-warn', 'Squelch type errors')
	   .option('--pts-dot', 'Print graphviz dot for points-to graph')
program.parse(process.argv);

if (program.args.length < 2) {
	program.help()
}

// usage: tscheck SNAPSHOT INTERACE
var snapshotFile = program.args[0]
var snapshotText = fs.readFileSync(snapshotFile, 'utf8');
var snapshot = JSON.parse(snapshotText);

var typeDeclFile = program.args[1];
var typeDeclText = fs.readFileSync(typeDeclFile, 'utf8');

var sourceFile = program.args[2] || null;
var sourceFileAst;
if (sourceFile) {
	var sourceFileText = fs.readFileSync(sourceFile, 'utf8')
	sourceFileAst = esprima.parse(sourceFileText, {loc:true})
} else {
	sourceFileAst = null
}

var libFile = __dirname + "/lib/lib.d.ts";
var libFileText = fs.readFileSync(libFile, 'utf8');

var LIB_ORIGIN = ">lib.d.ts"; // pad origin with ">" to ensure it does not collide with user input

var typeDecl = tscore([
		{file: LIB_ORIGIN, text:libFileText},
		{file: typeDeclFile, text:typeDeclText}
	])

// -----------------------------------
// 		Miscellaneous util stuff
// -----------------------------------

var unique_error_ids = new Map;
function reportUniqueError(uid, msg) {
	if (unique_error_ids.has(uid))
		return;
	unique_error_ids.put(uid, true)
	console.log(msg)
}


function qualify(host, name) {
	if (host === '')
		return name;
	if (host.startsWith('module:'))
		return host.substring('module:'.length) + '::' + name;
	return host + '.' + name;
}

function jsonMap(obj,fn) {
	var result = {}
	for (var k in obj) {
		result[k] = fn(obj[k])
	}
	return result
}


// ---------------------------
// 		Lookup functions
// ---------------------------

function lookupObject(key) {
	var obj = snapshot.heap[key];
	if (!obj) {
		throw new Error("Missing object with key " + key)
	}
	return obj;
}

function lookupQType(qname, targs) {
	var tdecl = typeDecl.env[qname];
	if (!tdecl) {
		reportUniqueError('missing:' + qname, "Error: Type " + qname + " is not defined");
		return null;
	}
	if (targs.length !== tdecl.typeParameters.length) {
		reportUniqueError('targs:' + qname, "Error: Type " + qname + " expects " + tdecl.typeParameters.length + " type arguments but got " + targs.length);
		return null;
	}
	if (targs.length === 0)
		return tdecl.object; // optimization: skip substitution step if there are no type arguments
	var tenv = new Map
	for (var i=0; i<targs.length; i++) {
		tenv.put(tdecl.typeParameters[i], targs[i])
	}
	return substType(tdecl.object, tenv)
}
function resolveTypeRef(t) {
	return lookupQType(t.name, t.typeArguments)
}

function getPrototype(key) {
	var obj = lookupObject(key)
	return obj.prototype && obj.prototype.key
}
function findPrtyDirect(obj, name) {
	return obj.properties.find(function(x) { return x.name == name });
}
function findPrty(obj, name) {
	while (obj) {
		var prty = findPrtyDirect(obj,name)
		if (prty)
			return prty;
		obj = obj.prototype && lookupObject(obj.prototype.key);
	}
	return null;
}

// Cyclic Prototype Detection. (Mostly for debugging jsnap)

function checkCyclicPrototype(key) {
	var slow = key;
	var fast = key;
	while (true) {
		fast = getPrototype(fast)
		if (!fast)
			return false;
		fast = getPrototype(fast)
		if (!fast)
			return false;
		slow = getPrototype(slow)
		if (slow === fast)
			return true;
	}
}

// ---------------------------------
// 		 Name Type Expressions
// ---------------------------------

var tpath2type = new Map;
function nameType(type, tpath) {
	switch (type.type) {
		case 'object':
			type.path = tpath;
			tpath2type.put(tpath, type);
			for (var k in type.properties) {
				var typePrty = type.properties[k]
				nameType(typePrty.type, qualify(tpath, k))
			}
			if (type.numberIndexer) {
				nameType(type.numberIndexer, qualify(tpath, '[number]'))
			}
			if (type.stringIndexer) {
				nameType(type.stringIndexer, qualify(tpath, '[string]'))
			}
			type.calls.forEach(function(call,i) {
				call.typeParameters.forEach(function(tp,j) {
					tp.constraint && nameType(tp.constraint, qualify(tpath, 'call:' + i + 'bound:' + j))
				})
				call.parameters.forEach(function(parm,j) {
					nameType(parm.type, qualify(tpath, 'call:' + i + 'arg:' + j))
				})
				nameType(call.returnType, qualify(tpath, 'call:' + i + ':return'))
			})
			break;
		case 'reference':
			type.typeArguments.forEach(function(targ,i) {
				nameType(targ, qualify(tpath, 'typearg:' + i))
			})
			break;
	}
}
function nameAllTypes() {
	for (var k in typeDecl.env) {
		nameType(typeDecl.env[k].object, k)
	}	
}
nameAllTypes()

// ----------------------------------------------
// 		 Type Parameter Substitution
// ----------------------------------------------

function substTypeParameters(tparams, tenv) {
	if (tparams.length === 0)
		return { typeParams: [], tenv: tenv };
	tenv = tenv.clone()
	var typeParams = []
	tparams.forEach(function (tparam) {
		tenv.remove(tparam.name)
		typeParams.push({
			name: tparam.name,
			constraint: tparam.constraint && substType(tparam.constraint, tenv)
		})
	})
	return {
		typeParams: typeParams,
		tenv: tenv
	}
}
function substParameter(param, tenv) {
	return {
		name: param.name,
		optional: param.optional,
		type: substType(param.type, tenv)
	}
}
function substCall(call, tenv) {
	var typeParamSubst = substTypeParameters(call.typeParameters, tenv)
	var typeParams = typeParamSubst.typeParams
	tenv = typeParamSubst.tenv
	return {
		new: call.new,
		variadic: call.variadic,
		typeParameters: typeParams,
		parameters: call.parameters.map(substParameter.fill(undefined, tenv)),
		returnType: substType(call.returnType, tenv),
		meta: call.meta
	}
}
function substPrty(prty, tenv) {
	return {
		optional: prty.optional,
		type: substType(prty.type, tenv),
		meta: prty.meta
	}
}
function substType(type, tenv) {
	switch (type.type) {
	case 'type-param':
		var t = tenv.get(type.name);
		if (t)
			return t;
		else
			return type; // this happens for function type params
	case 'object':
		return {
			type: 'object',
			typeParameters: [],
			properties: jsonMap(type.properties, substPrty.fill(undefined,tenv)),
			calls: type.calls.map(substCall.fill(undefined,tenv)),
			stringIndexer: type.stringIndexer && substType(type.stringIndexer, tenv),
			numberIndexer: type.numberIndexer && substType(type.numberIndexer, tenv),
			path: type.path,
			meta: type.meta
		}
		break;
	case 'reference':
		return {
			type: 'reference',
			name: type.name,
			typeArguments: type.typeArguments.map(substType.fill(undefined,tenv))
		}
	default:
		return type;
	}
}


// ---------------------------------
// 		 Type Canonicalization
// ---------------------------------

var canonical_cache = {}
var canonical_next_number = 1;
function canonicalizeKey(key) {
	var value = canonical_cache[key]
	if (!value) {
		value = canonical_next_number++
		canonical_cache[key] = value
	}
	return value
}
function escapeStringConst(str) {
	return str; // todo, but only necessary in unrealistic circumstances
}
function canonicalizeValue(value) {
	switch (typeof value) {
		case 'function':
		case 'object':
			if (value === null)
				return '_';
			else
				return '#' + value.key;
		case 'boolean':
			return value ? 't' : 'f';
		case 'number':
			return 'n:' + value
		case 'string':
			return 'C:' + escapeStringConst(value) // note: intentially coincide with string-const type
		case 'undefined':
			return 'u';
		default:
			throw new Error("unknown value " + util.inspect(value));
	}
}
function canonicalizeCall(call) {
	var buf = []
	if (call.new)
		buf.push('+new')
	if (call.variadic)
		buf.push('+var')
	buf.push('<')
	call.typeParameters.forEach(function(tp) {
		buf.push(tp.name)
		buf.push(',')
	})
	buf.push('>(')
	call.parameters.forEach(function(param) {
		buf.push(param.optional ? '?' : '')
		buf.push(canonicalizeType(param.type))
		buf.push(';')
	})
	buf.push(')')
	buf.push(canonicalizeType(call.returnType))
	var key = buf.join('')
	return canonicalizeKey(key)
}
function canonicalizeType(type) {
	switch (type.type) {
		case 'object':
			if (type.canonical_id)
				return type.canonical_id;
			var bag = []
			for (k in type.properties) {
				var prty = type.properties[k]
				bag.push(k + (prty.optional ? '?' : '') + ':' + canonicalizeType(prty.type))
			}
			type.calls.forEach(function(call) {
				bag.push('#' + canonicalizeCall(call))
			})
			if (type.stringIndexer)
				bag.push('[S]:' + canonicalizeType(type.stringIndexer))
			if (type.numberIndexer)
				bag.push('[N]:' + canonicalizeType(type.numberIndexer))
			var key = bag.sort().join(';')
			var id = canonicalizeKey(key);
			type.canonical_id = id;
			return id;
		case 'reference':
			if (type.typeArguments.length > 0) {
				var key = '@' + type.name + '<' + type.typeArguments.map(canonicalizeType).join(';') + '>'
				return canonicalizeKey(key)
			} else {
				return '@' + type.name;
			}
		case 'number':
			return 'N';
		case 'boolean':
			return 'B';
		case 'string':
			return 'S';
		case 'string-const':
			return 'C:' + escapeStringConst(type.value)
		case 'any':
			return 'A';
		case 'void':
			return 'V';
		case 'enum':
			return 'E:' + type.name;
		case 'value':
			return 'W:' + canonicalizeValue(type.value);
		default:
			throw new Error("Unrecognized type: " + util.inspect(type))
	}
}

// ------------------------------------------------------------
// 		 Index Properties
// ------------------------------------------------------------

function indexProperties(obj) {
	if (!obj)
		return;
	if (obj.propertyMap)
		return;
	obj.propertyMap = new Map;
	obj.properties.forEach(function(prty) {
		obj.propertyMap.put(prty.name, prty);
	})
	if (!obj.prototype)
		return;
	var parent = lookupObject(obj.prototype.key);
	indexProperties(parent)
	parent.propertyMap.forEach(function(name,prty) {
		if (!obj.propertyMap.has(name)) {
			obj.propertyMap.put(name,prty);
		}
	})
}
snapshot.heap.forEach(indexProperties);

function lookupPath(path, e) {
	e = e || function() { throw new Error("Missing value at " + path) }
	var value = {key: snapshot.global}
	var toks = path.split('.')
	for (var i=0; i<toks.length; i++) {
		var tok = toks[i];
		if (typeof value !== 'object') {
			return e(path);
		}
		var obj = lookupObject(value.key);
		var prty = obj.propertyMap.get(tok);
		if (!prty || !('value' in prty)) {
			return e(path);
		}
		value = prty.value;
	}
	return value;
}

// ------------------------------------------------------------
// 		 Determine Enum Values
// ------------------------------------------------------------

var enum_values = new Map;
function determineEnums() {
	for (var qname in typeDecl.enums) {
		var paths = typeDecl.enums[qname];
		var values = paths.map(lookupPath.fill(undefined, function(path) {
			console.log("Enum " + qname + " is missing value " + path)
			return null;
		}));
		enum_values.put(qname, values);
	}
}
determineEnums();

// ------------------------------------------------------------
// 		 ToObject Coercion
// ------------------------------------------------------------

var NumberPrototype = lookupPath("Number.prototype");
var StringPrototype = lookupPath("String.prototype");
var BooleanPrototype = lookupPath("Boolean.prototype");
var FunctionPrototype = lookupPath("Function.prototype");

function coerceToObject(x) {
	switch (typeof x) {
		case 'number': return NumberPrototype;
		case 'string': return StringPrototype;
		case 'boolean': return BooleanPrototype;
		default: return x;
	}
}

function coerceTypeToObject(x) {
	switch (x.type) {
		case 'number': return {type: 'reference', name:'Number'}
		case 'string': return {type: 'reference', name:'String'}
		case 'string-const': return {type: 'reference', name:'String'}
		case 'boolean': return {type: 'reference', name:'Boolean'}
		default: return x
	}
}

// ------------------------------------------------------------
// 		 Recursive check of Value vs Type
// ------------------------------------------------------------

// True if `x` is the canonical representation of an integer (no leading zeros etc)
function isNumberString(x) {
	return x === String(Math.floor(Number(x)))
}
// True if `x` can be converted to a number
function isNumberLikeString(x) {
	return x == 0 || !!Number(x)
}


var tpath2warning = new Map;
function reportError(msg, path, tpath) {
	var append = ''
	if (program.compact && tpath2warning.has(tpath)) {
		// append = ' [REPEAT]'
		return
	}
	tpath2warning.put(tpath, true)
	if (program.warn) {
		console.log((path || '<global>') + ": " + msg + append)
	}
}

var tpath2values = new Map;
var native_tpaths = new Map;
var assumptions = {}
function check(type, value, path, userPath, parentKey, tpath) {
	function must(condition) {
		if (!condition) {
			if (userPath) {
				reportError("expected " + formatType(type) + " but found value " + formatValue(value), path, tpath);
			}
			return false;
		} else {
			return true;
		}
	}
	if (!type) {
		throw new Error("Undefined type on path: " + path)
	}
	if (value === null) {
		return; // null satisfies all types
	}
	switch (type.type) {
		case 'object':
			if (!type.path) {
				console.log("Missing type path at value " + path)
			}
			tpath = type.path; // override tpath with object's own path
			tpath2values.push(type.path, value)
			if (!userPath) {
				native_tpaths.put(type.path, true)
			}
			value = coerceToObject(value);
			if (must(typeof value === 'object')) {
				var obj = lookupObject(value.key)
				if (checkCyclicPrototype(value.key)) {
					reportError("Cyclic prototype chain", path, tpath);
					return;
				}
				for (var k in type.properties) {
					var typePrty = type.properties[k]
					var isUserPrty = typePrty.meta.origin != LIB_ORIGIN;
					var isUserPath = userPath || isUserPrty;
					var objPrty = obj.propertyMap.get(k) //findPrty(obj, k)
					if (!objPrty) {
						if (!typePrty.optional && isUserPath) {
							var can_be_optional = type.meta.kind === 'interface'; // only interfaces can have optional members
							if (typePrty.type.type === 'boolean' && !can_be_optional) {
								// filter out warnings about absent boolean flags, where the flag cannot be declared optional
							} else {
								reportError("expected " + formatType(typePrty.type) + " but found nothing", qualify(path,k), qualify(tpath,k))
							}
						}
					} else {
						if ('value' in objPrty) {
							check(typePrty.type, objPrty.value, qualify(path,k), isUserPath, value.key, qualify(tpath,k))
						} else {
							// todo: getters and setters require static analysis
						}
					}
				}
				if (type.stringIndexer && type.stringIndexer.type !== 'any') {
					obj.propertyMap.forEach(function(name,objPrty) {
						if (objPrty.enumerable && 'value' in objPrty) {
							check(type.stringIndexer, objPrty.value, path + '[\'' + name + '\']', userPath, value.key, tpath + '[string]')
						}
					})
				}
				if (type.numberIndexer && type.numberIndexer.type !== 'any') {
					obj.propertyMap.forEach(function(name,objPrty) {
						if (isNumberString(name) && 'value' in objPrty) {
							check(type.numberIndexer, objPrty.value, path + '[' + name + ']', userPath, value.key, tpath + '[number]')
						}
					})
				}
				if (userPath) {
					type.calls.forEach(function (call) {
						if (!call.meta.implicit) { // do not check default constructor
							checkCallSignature(call, parentKey, value.key, path)
						}
					})	
				}
				if (type.brand) {
					if (hasBrand(value, type.brand) === false) {
						reportError("missing prototype for branded type " + type.brand, path, tpath)
					}
				}
			}
			break;
		case 'reference':
			value = coerceToObject(value)
			if (!must(typeof value === 'object'))
				return; // only object types can match a reference
			var assumKey = value.key + '~' + canonicalizeType(type)
			if (assumptions[assumKey])
				return; // already checked or currently checking
			assumptions[assumKey] = true
			var objectType = lookupQType(type.name, type.typeArguments)
			if (!objectType)
				return; // error issued elsewhere
			check(objectType, value, path, userPath, parentKey, type.name)
			break;
		case 'enum':
			var vals = enum_values.get(type.name);
			if (vals.length === 0) {
				must(typeof value !== 'undefined');
			} else {
				must(vals.some(function(x) { return valuesStrictEq(x,value) }));
			}
			break;
		case 'string-const':
			must(typeof value === 'string' && value === type.value)
			break;
		case 'number':
			must(typeof value === 'number');
			break;
		case 'string':
			must(typeof value === 'string');
			break;
		case 'boolean':
			must(typeof value === 'boolean');
			break;
		case 'any':
			break; // no check necessary
		case 'void':
			must(typeof value === 'undefined');
			break;
		case 'type-param':
			// should be replaced by substType before we get here
			throw new Error("Checking value " + formatValue(value) + " against unbound type parameter " + type.name);
		default:
			throw new Error("Unrecognized type type: " + type.type + " " + util.inspect(type))
	}
}

function valuesStrictEq(x,y) {
	if (x === y)
		return true
	if (x && typeof x === 'object' && y && typeof y === 'object')
		return x.key === y.key
	return false
}

// Returns true if brand is satisfied, false if brand is not satisfied, or null if brand prototype could not be found.
function hasBrand(value, brand) {
	var ctor = lookupPath(brand, function() { return null })
	if (!ctor || typeof ctor !== 'object')
		return null;
	var proto = lookupObject(ctor.key).propertyMap.get('prototype')
	if (!proto || !proto.value || typeof proto.value !== 'object')
		return null;
	while (value && typeof value === 'object') {
		if (value.key === proto.value.key)
			return true
		value = lookupObject(value.key).prototype
	}
	return false;
}

function checkCallSignature(call, receiverKey, functionKey, path) {
	var functionObj = lookupObject(functionKey)
	if (!functionObj.function) {
		console.log(path + ": expected " + formatTypeCall(call) + " but found non-function object")
		return
	}
	if (!isCallSatisfiedByObject(call, {type: 'value', value: {key: receiverKey}}, functionKey)) {
		console.log(path + ": does not satisfy signature " + formatTypeCall(call))
	}
}

// --------------------
// 		Subtyping
// --------------------

var subtype_assumptions = Object.create(null);
function isSubtypeOf(x, y) { // x <: y
	switch (y.type) {
		case 'object':
			// x <: {..}
			x = coerceTypeToObject(x)
			if (x.type === 'reference') {
				x = lookupQType(x.name, x.typeArguments)
			}
			if (x.type !== 'object')
				return false;
			for (var k in y.properties) {
				if (!x.hasOwnProperty(k))
					return false
				if (x.properties[k].optional && !y.properties[k].optional) {
					return false // {f?:T} is not subtype of {f:T}
				}
				if (!isSubtypeOf(x.properties[k].type, y.properties[k].type)) {
					return false
				}
			}
			if (y.stringIndexer) {
				if (!x.stringIndexer)
					return false
				if (!isSubtypeOf(x.stringIndexer, y.stringIndexer))
					return false
			}
			if (y.numberIndexer) {
				if (!x.numberIndexer)
					return false
				if (!isSubtypeOf(x.numberIndexer, y.numberIndexer))
					return false
			}
			// TODO: call signatures?
			return true
		case 'reference':
			var key = canonicalizeType(x) + '~' + canonicalizeType(y)
			if (key in subtype_assumptions)
				return subtype_assumptions[key]
			subtype_assumptions[key] = true
			return subtype_assumptions[key] = isSubtypeOf(x, lookupQType(y.name, y.typeArguments))
		case 'enum':
			return (x.type === 'enum' && x.name === y.name)
		case 'string-const':
			return (x.type === 'string-const' && x.value === y.value)
		case 'number':
			return (x.type === 'number')
		case 'string':
			return (x.type === 'string' || x.type === 'string-const')
		case 'boolean':
			return (x.type === 'boolean')
		case 'any':
			return true;
		case 'void':
			return (x.type === 'void')
		case 'type-param':
			throw new Error("Checking subtype vs unbound type parameter: " + util.inspect(y))
		default:
			throw new Error("Unrecognized type type: " + y.type + " " + util.inspect(y))
	}
}

// --------------------------------------------
// 		Suggest Additions to the Interface     
// --------------------------------------------

var SkipFunctionPrtys = ['name', 'length', 'arguments', 'caller', 'callee', 'prototype'];

function skipPrty(obj, name) {
	if (obj.function) {
		if (SkipFunctionPrtys.some(name))
			return true; // don't suggest built-in properties
		var funProto = lookupObject(FunctionPrototype.key)
		if (funProto.propertyMap.has(name))
			return true; // don't suggest properties inherited from Function.prototype
	}
	if (name[0] === '_') // names starting with underscore are almost always private
		return true;
	return false;
}

function findSuggestions() {
	tpath2values.forEach(function(tpath, values) {
		if (native_tpaths.has(tpath))
			return;
		var type = tpath2type.get(tpath)
		if (!type) {
			console.log("Invalid tpath = " + tpath)
			return
		}
		var names = new Map
		values.forEach(function(value) {
			value = coerceToObject(value)
			if (typeof value !== 'object')
				return;
			var obj = lookupObject(value.key)
			obj.propertyMap.forEach(function(name,prty) {
				if (type.properties[name]) // ignore if type already declares this property
					return;
				if (type.stringIndexer && prty.enumerable) // property covered by string indexer
					return;
				if (type.numberIndexer && isNumberString(name)) // property covered by number indexer
					return;
				if (skipPrty(obj,name)) // uninteresting property
					return;
				names.increment(name)
			})
		})
		names.forEach(function(name,count) {
			var alwaysPresent = (count === values.length);
			var optStr = alwaysPresent ? '' : '(optional)';
			console.log(qualify(tpath,name) + ': missing from .d.ts ' + optStr)
		})
	})
}

// --------------------------------------------
// 		Coverage
// --------------------------------------------

var coverage = {
	types: {
		total: 0,
		used: 0
	},
	names: {
		total: 0,
		used: 0
	},
	reachable: {} // names of reachable types in type environment
}

function reachableCall(call) {
	call.typeParameters.forEach(function(tp) {
		if (tp.constraint)
			reachableType(tp.constraint)
	})
	call.parameters.forEach(function(p) {
		reachableType(p.type)
	})
	reachableType(call.returnType)
}
function reachableType(type) {
	switch (type.type) {
		case 'object':
			for (var k in type.properties) {
				reachableType(type.properties[k].type)
			}
			type.calls.forEach(reachableCall)
			if (type.stringIndexer)
				reachableType(type.stringIndexer)
			if (type.numberIndexer)
				reachableType(type.numberIndexer)
			break;
		case 'reference':
			type.typeArguments.forEach(reachableType)
			if (!coverage.reachable[type.name]) {
				coverage.reachable[type.name] = true;
				var t = typeDecl.env[type.name]
				if (t) {
					reachableType(t.object);
				}
			}
			break;
	}
}

function typeCoverageCall(call, r) {
	call.typeParameters.forEach(function(tp) {
		if (tp.constraint) {
			typeCoverage(tp.constraint, false);
		}
	})
	call.parameters.forEach(function(param) {
		typeCoverage(param.type, false);
	})
	typeCoverage(call.returnType, false);
}

function typeCoverage(type, r) {
	if (type.type === 'object' && type.meta.origin == LIB_ORIGIN)
		return; // don't measure coverage inside lib.d.ts
	coverage.types.total++;
	switch (type.type) {
		case 'object':
			r = !!tpath2values.get(type.path);
			if (r)
				coverage.types.used++;
			for (var k in type.properties) {
				if (type.properties[k].meta.origin != LIB_ORIGIN) {
					coverage.names.total++;
					if (r) {
						coverage.names.used++;
					}
				}
				typeCoverage(type.properties[k].type, r);
			}
			// we don't measure call signatures in this statistic
			// type.calls.forEach(function(call) {
			// 	typeCoverageCall(call, r);
			// })
			if (type.stringIndexer)
				typeCoverage(type.stringIndexer, r);
			if (type.numberIndexer)
				typeCoverage(type.numberIndexer, r);
			break;
		case 'reference':
			type.typeArguments.forEach(function(t) {
				typeCoverage(t, r);
			})
			break;
		default:
			if (r) {
				coverage.types.used++;
			}
	}
}

function printCoverage() {
	// Find reachable types
	coverage.reachable[typeDecl.global] = true;
	reachableType(typeDecl.env[typeDecl.global].object);

	// Find type expressions checked by our procedure
	for (var k in typeDecl.env) {
		if (!coverage.reachable[k])
			continue; // don't measure coverage for unused type definitions, it is meaningless to look for bugs in those
		typeCoverage(typeDecl.env[k].object, false);
	}
	function percent(x,y) {
		if (y === 0)
			y = 1;
		return (100 * x / y);
	}
	function str(cov) {
		return cov.used + " / " + cov.total + " (" + percent(cov.used,cov.total).toFixed(2) + "%)";
	}
	console.log("TYPE COVERAGE " + str(coverage.types));
	console.log("NAME COVERAGE " + str(coverage.names));
}

// ------------------------------------------
// 		Formatting types and values          
// ------------------------------------------

// TODO: restrict depth to avoid printing gigantic types

function formatTypeProperty(name,prty) {
	return name + (prty.optional ? '?' : '') + ': ' + formatType(prty.type)
}
function formatTypeParameter(tparam) {
	return tparam.name;
}
function formatTypeCall(call) {
	var newstr = call.new ? 'new' : '';
	var tparams = call.typeParameters.length === 0 ? '' : ('<' + call.typeParameters.map(formatTypeParameter).join(',') + '>')
	return newstr + tparams + '(' + call.parameters.map(formatParameter).join(', ') + ') => ' + formatType(call.returnType)
}
function formatParameter(param) {
	return param.name + (param.optional ? '?' : '') + ':' + formatType(param.type)
}

function formatType(type) {
	switch (type.type) {
		case 'object':
			var members = []
			for (var k in type.properties) {
				var prty = type.properties[k];
				members.push(k + (prty.optional ? '?' : '') + ': ' + formatType(prty.type))
			}
			members = members.concat(type.calls.map(formatTypeCall).join(', '));
			return '{' + members.join(', ') + '}'
		case 'reference':
			if (type.typeArguments.length > 0)
				return type.name + '<' + type.typeArguments.map(formatType).join(', ') + '>'
			else
				return type.name;
		case 'type-param':
			return type.name;
		case 'string':
			return 'string';
		case 'number':
			return 'number';
		case 'boolean':
			return 'boolean';
		case 'void':
			return 'void';
		case 'any':
			return 'any';
		case 'string-const':
			return '"' + type.value + '"';
		case 'enum':
			return type.name;
		case 'value':
			return 'value(' + formatValue(type.value) + ')'
	}
	return util.inspect(type)
}
function formatValue(value, depth) {
	if (typeof depth === 'undefined')
		depth = 1;
	if (typeof value === 'object' && value !== null) {
		if (depth <= 0)
			return value.function ? '[Function]' : '[Object]'
		var fn = value.function ? 'Function ' : ''
		return fn + '{ ' + lookupObject(value.key).properties.map(function(prty) { return prty.name + ': ' + formatValue(prty.value,depth-1) }).join(', ') + ' }'
	} else {
		return util.inspect(value)
	}
}


// ----------------------
// 		UNION TYPES
// ----------------------

function UnionType() {
	this.any = false
	this.table = Object.create(null)
}
UnionType.prototype.add = function(t) {
	if (this.any)
		return false
	if (t.type === 'any') {
		this.any = true
		this.table = null
		return true
	}
	var h = canonicalizeType(t)
	if (h in this.table)
		return false
	this.table[h] = t
	return true
}
UnionType.prototype.consume = function(ut) {
	if (this.any)
		return
	if (ut.any) {
		this.any = true
		this.table = null
		return
	}
	for (var k in ut.table) {
		this.table[k] = ut.table[k]
	}
}
UnionType.prototype.some = function(f) {
	if (this.any)
		return f({type: 'any'})
	var table = this.table
	for (var k in table) {
		if (f(table[k])) {
			return true
		}
	}
	return false
}
UnionType.prototype.forEach = function(f) {
	if (this.any) {
		f({type: 'any'})
		return
	}
	var table = this.table
	for (var k in table) {
		f(table[k])
	}
}

// ----------------------
// 		UNION-FIND
// ----------------------

var unode_id = 1
function UNode() {
	this.parent = this
	this.rank = 0
	this.properties = new Map
	this.type = new UnionType
	this.prototypes = Object.create(null)
	this.id = unode_id++
}
UNode.prototype.rep = function() {
	var p = this.parent
	if (p === this)
		return p
	return this.parent = p.rep()
};
UNode.prototype.getPrty = function(name) {
	var r = this.rep()
	var n = r.properties.get(name)
	if (!n) {
		n = new UNode
		r.properties.put(name, n)
	}
	return n
}


function Unifier() {
	this.queue = []
}
Unifier.prototype.unify = function(n1, n2) {
	n1 = n1.rep()
	n2 = n2.rep()
	if (n1 === n2)
		return
	if (n2.rank > n1.rank) {
		var z = n1; n1 = n2; n2 = z; // swap n1/n2 so n1 has the highest rank
	}
	if (n1.rank === n2.rank) {
		n1.rank++
	}
	n2.parent = n1
	for (var k in n2.properties) {
		if (k[0] !== '$')
			continue
		var p2 = n2.properties[k]
		if (k in n1.properties) {
			var p1 = n1.properties[k]
			this.unifyLater(p1, p2)
		} else {
			n1.properties[k] = p2
		}
	}
	for (var k in n2.prototypes) {
		n1.prototypes[k] = true
	}
	n1.type.consume(n2.type)
	n2.properties = null
	n2.type = null
	n2.prototypes = null
};
Unifier.prototype.unifyPrty = function(n1, prty, n2) {
	n1 = n1.rep()
	n2 = n2.rep()
	var k = '$' + prty
	var p1 = n1.properties[k]
	if (p1) {
		this.unifyLater(p1, n2)
	} else {
		n1.properties[k] = n2
	}
};

Unifier.prototype.unifyLater = function(n1, n2) {
	if (n1 !== n2) {
		this.queue.push(n1)
		this.queue.push(n2)
	}
}

Unifier.prototype.complete = function() {
	while (this.queue.length > 0) {
		var n1 = this.queue.pop()
		var n2 = this.queue.pop()
		this.unify(n1, n2)
	}
}

// -----------------------------
// 		 TYPE PROPAGATION
// -----------------------------

// Finds strongly connected components in the points-to graph
//
// Adds the following fields to union-find root nodes:
// - $scc: pointer to representative of SCC
// - $components (repr of SCC only): list of members in SCC
//
// Returns the list of representative nodes, topologically sorted
function computeSCCs(nodes) {  // see: http://en.wikipedia.org/wiki/Tarjan's_strongly_connected_components_algorithm
	var components = []
	var index = 0
	var stack = []
	for (var i=0; i<nodes.length; i++) {
		var node = nodes[i]
		if (node.rep() === node) {
			if (typeof node.$scc_index !== 'number') {
				scc(node)
			}
		}
	}
	function scc(v) {
		v.$scc_index = index
		v.$scc_lowlink = index
		index++
		stack.push(v)

		for (var k in v.properties) {
			if (k[0] !== '$')
				continue
			var w = v.properties[k].rep()
			if (typeof w.$scc_index !== 'number') {
				scc(w)
				v.$scc_lowlink = Math.min(v.$scc_lowlink, w.$scc_lowlink)
			} else if (w.$onstack) {
				v.$scc_lowlink = Math.min(v.$scc_lowlink, w.$scc_index)
			}
		}

		if (v.$scc_lowlink === v.$scc_index) {
			components.push(v)
			var cmp = v.$component = []
			var w;
			do {
				w = stack.pop()
				cmp.push(w)
				w.$scc = v
			} while (w !== v);
		}
	}
	components.reverse() // reversing this makes it topologically sorted
	return components
}

function propagateTypes(nodes) {
	var components = computeSCCs(nodes)
	components.forEach(function(c) {
		// propagate round inside component
		var worklist = []
		function enqueue(node) {
			if (!node.$in_worklist) {
				worklist.push(node)
				node.$in_worklist = true
			}
		}
		c.$component.forEach(enqueue)
		while (worklist.length > 0) {
			var node = worklist.pop()
			node.$in_worklist = false
			node.properties.forEach(function(prty, dst) {
				dst = dst.rep()
				if (dst.$scc !== c)
					return
				node.type.forEach(function(t) {
					lookupOnType(t,prty).forEach(function (t2) {
						if (dst.type.add(t2)) {
							enqueue(dst)
						}
					})
				})
			})
		}
		// propagate outward to successors
		c.$component.forEach(function(node) {
			node.properties.forEach(function(prty, dst) {
				dst = dst.rep()
				if (dst.$scc === c)
					return
				node.type.forEach(function(t) {
					lookupOnType(t,prty).forEach(function(t2) {
						dst.type.add(t2)
					})
				})
			})
		})
	})
}

function lookupOnType(t, name) { // type X string -> type[]
	t = coerceTypeToObject(t)
	if (t.type === 'reference')
		t = resolveTypeRef(t)
	switch (t.type) {
		case 'any': 
			return [{type:'any'}]
		case 'object':
			var prty = t.properties[name]
			if (prty) {
				return [prty.type]
			}
			if (t.numberIndexer !== null && isNumberString(name)) {
				return [t.numberIndexer]
			}
			if (t.stringIndexer !== null) {
				return [t.stringIndexer]
			}
			return []
		case 'enum':
			var enumvals = enum_values.get(t.name)
			if (enumvals.length === 0)
				return [{type: 'any'}]
			var keys = enumvals.map(function(v) {
				v = coerceToObject(v)
				if (v && typeof v === 'object')
					return v.key
				else
					return null // removed by compact below
			}).compact().unique()
			var values = keys.map(function(key) {
				var obj = lookupObject(key)
				var prty = obj.propertyMap.get(name)
				if (prty) {
					return {type: 'value', value: prty.value}
				} else {
					return null // removed by compact below
				}
			}).compact()
			return values
		case 'value':
			var v = coerceToObject(t.value)
			if (v.value && typeof v.value === 'object') {
				var obj = lookupObject(t.value.key)
				var prty = obj.propertyMap.get(name)
				if (prty) {
					return [{type: 'value', value: prty.value}]
				}
			}
			return []
		default:
			return []
	}
}


// ----------------------------------
// 		Type-Type Compatibility
// ----------------------------------

var type2type_compatible = Object.create(null)
var object2type_compatible = Object.create(null)
function isTypeCompatible(input, output) {
	if (input.type === 'any' || output.type === 'any')
		return true
	if (input.type === 'value' && input.value === null)
		return true
	if (input.type === 'reference' || output.type === 'reference') {
		var h = canonicalizeType(input) + "~" + canonicalizeType(output)
		if (h in type2type_compatible)
			return type2type_compatible[h]
		type2type_compatible[h] = true
		if (input.type === 'reference')
			input = resolveTypeRef(input)
		if (output.type === 'reference')
			output = resolveTypeRef(output)
		return type2type_compatible[h] = isTypeCompatible(input, output)
	}
	switch (output.type) {
		case 'object':
			input = coerceTypeToObject(input)
			switch(input.type) {
				case 'object':
					for (var k in output.properties) {
						var oprty = output.properties[k]
						if (k in input.properties) {
							if (!isTypeCompatible(input.properties[k].type, oprty.type)) {
								return false
							}
						} else {
							if (!oprty.optional)
								return false // TODO: look up using indexer
						}
					}
					var callsOK = output.calls.all(function(oc) {
						return input.calls.some(function(ic) {
							return isCallSubtypeOf(ic, oc)
						})
					})
					if (!callsOK)
						return false
					return true
				case 'value':
					var v = coerceToObject(input.value)
					if (v && typeof v === 'object') {
						var h = canonicalizeType(v.key) + "~" + canonicalizeType(output)
						if (h in object2type_compatible)
							return object2type_compatible[h]
						object2type_compatible[h] = true
						var obj = lookupObject(v.key)
						for (var k in output.properties) {
							var oprty = output.properties[k]
							var inprty = obj.propertyMap.get(k)
							if (inprty) {
								if ('value' in inprty) {
									if (!isTypeCompatible({type:'value', value:inprty.value}, oprty.type)) {
										return object2type_compatible[h] = false
									}
								}
							} else {
								if (!oprty.optional) {
									return object2type_compatible[h] = false
								}
							}
						}
						return true
					} else {
						return false
					}
				default:
					return false
			}
		case 'string':
			input = substituteParameterType(input)
			return input.type === 'string' || (input.type === 'value' && typeof input.value === 'string')
		case 'string-const':
			input = substituteParameterType(input)
			return input.type === 'string' || (input.type === 'value' && input.value === output.value) // TODO: subtype or compatibility??
		case 'number':
			return input.type === 'number' || (input.type === 'value' && typeof input.value === 'number')
		case 'boolean':
			return input.type === 'boolean' || (input.type === 'value' && typeof input.value === 'boolean')
		case 'enum':
			var vals = enum_values.get(output.name)
			if (vals.length === 0)
				return true
			return vals.some(function(v) {
				return isTypeCompatible(input, {type: 'value', value: v})
			})
		case 'void':
			return true
		case 'any':
			return true
		case 'type-param':
			return true // TODO: type-param
		default:
			throw new Error("isTypeCompatible " + input.type + " vs " + output.type)
	}
}

function isCallSubtypeOf(incall, outcall) {
	// TODO: type parameters
	// TODO: variadic

	// Check that the parameters to outcall can be used in a valid call to incall
	for (var i=0; i<incall.parameters.length; ++i) {
		var iparm = incall.parameters[i]
		if (i < outcall.parameters.length) {
			var oparm = outcall.parameters[i]
			if (!isTypeCompatible(oparm.type, iparm.type)) {
				return false
			}
		} else if (!iparm.optional) {
			return false
		}
	}

	// Check that return type from incall is a valid return type from outcall
	return isTypeCompatible(incall.returnType, outcall.returnType)
}

// --------------------------
// 		Static Analysis
// --------------------------


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

// Assigns parent pointers to each node. The parent pointer is called $parent.
function injectParentPointers(node, parent) {
    node.$parent = parent;
    var list = children(node);
    for (var i=0; i<list.length; i++) {
        injectParentPointers(list[i], node);
    }
}

// Returns the function or program immediately enclosing the given node, possibly the node itself.
function getEnclosingFunction(node) {
    while  (node.type !== 'FunctionDeclaration' && 
            node.type !== 'FunctionExpression' && 
            node.type !== 'Program') {
        node = node.$parent;
    }
    return node;
}

// Returns the function, program or catch clause immediately enclosing the given node, possibly the node itself.
function getEnclosingScope(node) {
    while  (node.type !== 'FunctionDeclaration' && 
            node.type !== 'FunctionExpression' && 
            node.type !== 'CatchClause' &&
            node.type !== 'Program') {
        node = node.$parent;
    }
    return node;
}

// Injects an the following into functions, programs, and catch clauses
// - $env: Map from variable names in scope to Identifier at declaration
// - $depth: nesting depth from top-level
function injectEnvs(node) {
    switch (node.type) {
        case 'Program':
            node.$env = new Map;
            node.$depth = 0;
            break;
        case 'FunctionExpression':
            node.$env = new Map;
            node.$depth = 1 + getEnclosingScope(node.$parent).$depth;
            if (node.id) {
                node.$env.put(node.id.name, node.id)
            }
            for (var i=0; i<node.params.length; i++) {
                node.$env.put(node.params[i].name, node.params[i])
            }
            node.$env.put('arguments', node)
            break;
        case 'FunctionDeclaration':
            var parent = getEnclosingFunction(node.$parent); // note: use getEnclosingFunction, because fun decls are lifted outside catch clauses
            node.$env = new Map;
            node.$depth = 1 + parent.$depth;
            parent.$env.put(node.id.name, node.id)
            for (var i=0; i<node.params.length; i++) {
                node.$env.put(node.params[i].name, node.params[i])
            }
            node.$env.put('arguments', node)
            break;
        case 'CatchClause':
            node.$env = new Map;
            node.$env.put(node.param.name, node.param)
            node.$depth = 1 + getEnclosingScope(node.$parent).$depth;
            break;
        case 'VariableDeclarator':
            var parent = getEnclosingFunction(node) // note: use getEnclosingFunction, because vars ignore catch clauses
            parent.$env.put(node.id.name, node.id)
            break;
    }
    children(node).forEach(injectEnvs)
}


function numberASTNodes(ast) {
	var functions = []
	var next_id = 0
	function visit(node) {
		node.$id = ++next_id
		if (node.type === 'FunctionExpression' || node.type === 'FunctionDeclaration' || node.type === 'Program') {
			node.$function_id = functions.length
			functions.push(node)
		}
		children(node).forEach(visit)
	}
	visit(ast)
	ast.$id2function = functions
}

function getFunction(id) {
	return sourceFileAst && sourceFileAst.$id2function[id]
}

function prepareAST(ast) {
	numberASTNodes(ast)
	injectParentPointers(ast)
	injectEnvs(ast)
}

if (sourceFileAst) {
	prepareAST(sourceFileAst)
}



function substituteParameterType(t) {
	if (t.type === 'string-const') {
		return {type: 'value', value: t.value}
	} else {
		return t
	}
}

function isCallSatisfiedByType(call, this_type, t) {
	if (arguments.length !== 3)
		throw new Error("isCallSatisfiedByType takes 3 arguments")
	if (t.type === 'reference')
		t = resolveTypeRef(t)
	switch (t.type) {
		case 'value':
			if (t.value && typeof t.value === 'object') {
				return checkFunctionSig(call, t.value.key, this_type)
			} else {
				return false
			}
		case 'object':
			return t.calls.some(function(c) {
				return isCallSubtypeOf(c, call)
			})
		case 'any':
			return true
		default:
			return false
	}
}

var call_object_assumptions = Object.create(null)
function isCallSatisfiedByObject(call, this_type, fun_key) {
	if (arguments.length !== 3)
		throw new Error("isCallSatisfiedByObject takes 3 arguments")
	var fun_obj = lookupObject(fun_key)
	if (!fun_obj.function)
		return false // not a function object
	if (fun_obj.function.type !== 'user')
		return true // can't check (TODO: check 'bind' functions)

	var h = fun_key + "~" + canonicalizeCall(call) + (call.new ? '' : ("~" + canonicalizeType(this_type)))
	if (h in call_object_assumptions)
		return call_object_assumptions[h]
	call_object_assumptions[h] = true

	var fun = getFunction(fun_obj.function.id)
	var unifier = fun.$unifier = new Unifier
	var unodes = []
	function makeNode() {
		var n = new UNode
		unodes.push(n)
		return n
	}
	var astnode2unode = Object.create(null)
	function getNode(x) {
		if (x instanceof UNode)
			return x.rep()
		var n = astnode2unode[x.$id]
		if (n)
			return n.rep()
		return astnode2unode[x.$id] = makeNode()
	}
	function unify(x) {
		x = getNode(x)
		for (var i=1; i<arguments.length; ++i) {
			unifier.unify(x, getNode(arguments[i]))
		}
	}
	var astnode2env_node = Object.create(null)
	function getEnv(fun) {
		var n = astnode2env_node[fun.$id]
		if (n)
			return n.rep()
		return astnode2env_node[fun.$id] = makeNode()
	}
	function getVar(node) {
		var name = node.name
		var scope = getEnclosingScope(node)
		while (scope.type !== 'Program' && !scope.$env.has(name)) {
			scope = getEnclosingScope(scope.$parent)
		}
		return getEnv(scope).getPrty(name)
	}
	function getThis(fun) {
		return getEnv(fun).getPrty("@this")
	}
	function getSelf(fun) {
		return getEnv(fun).getPrty("@self")	
	}
	function getReturn(fun) {
		return getEnv(fun).getPrty("@return")	
	}
	function assumeAnyType(e) {
		getNode(e).type.add({type: 'any'})
	}
	function assumeType(e, t) {
		if (t.type === 'value' && t.value && typeof t.value === 'object') {
			unify(e, getConcreteObject(t.value.key))
		} else {
			getNode(e).type.add(t)
		}
	}
	function addPrototype(node, key) {
		// TODO: can we get away with this??
		getNode(node).type.add({type: 'value', value: {key: key}})
	}

	// getConcreteObject(x) maps an object key to a union-find node
	var concrete_objects = Object.create(null)
	function getConcreteObject(x) {
		var n = concrete_objects[x]
		if (!n) {
			concrete_objects[x] = n = makeNode()
			assumeType(n, {type: 'value', value: {key: x}})
		} else {
			n = n.rep()
		}
		return n
	}

	// We create union-find nodes for every variable in the environment
	// Their type is bound to the value held in the environment object,
	// and variables pointing to the same object are unified
	function visitEnvObjects() {
		var scope = getEnclosingScope(fun.$parent)
		var e = fun_obj.env
		while (e) {
			var obj = lookupObject(e.key)
			scope.$env.forEach(function(name) {
				var node = getEnv(scope).getPrty(name)
				var prty = obj.propertyMap.get(name)
				if (prty && 'value' in prty) {
					assumeType(node, {type: 'value', value:prty.value})
				}
			})
			e = obj.env
			scope = getEnclosingScope(scope.$parent)
		}
	}
	visitEnvObjects()

	// We use the types from the call signature on the parameters
	// FIXME: type parameters (either replace type-params by their bounds, or handle them directly)
	// FIXME: variadic functions
	function visitParameters() {
		for (var i=0; i<fun.params.length; i++) {
			unify(fun.params[i], getVar(fun.params[i]))
			if (i < call.parameters.length) {
				assumeType(fun.params[i], substituteParameterType(call.parameters[i].type))
			} else {
				assumeType(fun.params[i], {type: 'value', value: undefined})
			}
		}
	}
	visitParameters()

	// Assign a value to this and the function name
	function visitFunctionStuff() {
		assumeType(getSelf(fun), {type: 'value', value: {key: fun_key}})
		if (fun.type === 'FunctionExpression' && fun.id) {
			unify(fun.id, getVar(fun.id.name), getSelf(fun))
		}
		if (call.new) {
			var protoPrty = fun_obj.propertyMap.get("prototype")
			if (protoPrty && protoPrty.value && typeof protoPrty.value === 'object') {
				addPrototype(getThis(fun), protoPrty.value.key)
			}
		} else {
			assumeType(getThis(fun), this_type)
		}
	}
	visitFunctionStuff()

	var NULL = true
	var NOT_NULL = false
	var VOID = true // result is not used or is coerced to a boolean before being used
	var NOT_VOID = false
	function visitStmt(node) {
		switch (node.type) {
			case 'EmptyStatement':
				break;
			case 'BlockStatement':
				node.body.forEach(visitStmt)
				break;
			case 'ExpressionStatement':
				visitExpVoid(node.expression)
				break;
			case 'IfStatement':
				visitExpVoid(node.condition)
				break;
			case 'LabeledStatement':
				visitStmt(node.body)
				break;
			case 'BreakStatement':
				break;
			case 'ContinueStatement':
				break;
			case 'WithStatement':
				visitExp(node.object, NOT_VOID)
				visitStmt(node.body) // TODO: flag use of `with` and don't report errors from this function
				break;
			case 'SwitchStatement':
				visitExp(node.discriminant, NOT_VOID)
				node.cases.forEach(function(c) {
					if (c.test) {
						visitExpVoid(c.text, NOT_VOID)
					}
					c.consequent.forEach(visitStmt)
				})
				break;
			case 'ReturnStatement':
				if (node.argument) {
					visitExp(node.argument, NOT_VOID)
					unify(getReturn(getEnclosingFunction(node)), node.argument)
				}
				break;
			case 'ThrowStatement':
				visitExpVoid(node.argument)
				break;
			case 'TryStatement':
				visitStmt(node.block)
				if (node.handler) {
					assumeAnyType(node.handler.param)
					visitStmt(node.handler.body)
				}
				if (node.finalizer) {
					visitStmt(node.finalizer)
				}
				break;
			case 'WhileStatement':
				visitExpVoid(node.test)
				visitStmt(node.body)
				break;
			case 'DoWhileStatement':
				visitStmt(node.body)
				visitExpVoid(node.test)
				break;
			case 'ForStatement':
				if (node.init) {
					if (node.init.type === 'VariableDeclaration') {
						visitStmt(node.init)
					} else {
						visitExpVoid(node.init)
					}
				}
				if (node.test) {
					visitExpVoid(node.test)
				}
				if (node.update) {
					visitExpVoid(node.update)
				}
				visitExp(node.body)
				break;
			case 'ForInStatement':
				var lv;
				if (node.left.type === 'VariableDeclaration') {
					visitStmt(node.left)
					lv = node.left.declarations[0].id
				} else {
					visitExpVoid(node.left)
					lv = node.left
				}
				assumeType(lv, {type: 'string'})
				visitStmt(node.body)
				break;
			case 'DebuggerStatement':
				break;
			case 'FunctionDeclaration':
				visitStmt(node.body)
				// TODO: track functions values
				break;
			case 'VariableDeclaration':
				node.declarations.forEach(function(d) {
					unify(getVar(d.id.name), d.id)
					if (d.init) {
						var p = visitExp(d.init, NOT_VOID)
						if (p === NOT_NULL) {
							unify(d.id, d.init)
						}
					}
				})
				break;
			default:
				throw new Error("Unknown statement: " + node.type)
		}
	}
	function visitExpVoid(node) {
		return visitExp(node, VOID)
	}
	function visitExp(node, void_ctx) {
		switch (node.type) {
			case 'ArrayExpression':
				node.elements.forEach(function(elm, i) {
					if (!elm)
						return
					visitExp(elm, NOT_VOID)
					unifyPrty(node, String(i), elm)
				})
				addPrototype(node, lookupPath("Array.prototype").key)
				return NOT_NULL
			case 'ObjectExpression':
				node.properties.forEach(function(p) {
					visitExp(p.value, NOT_VOID)
					var name = p.key.type === 'Literal' ? String(p.key.value) : p.key.name
					switch (p.kind) {
						case 'init':
							unify(getNode(node).getPrty(name), p.value)
							break;
						case 'get':
							unify(node, getThis(p.value))
							unify(getNode(node).getPrty(name), getReturn(p.value))
							break;
						case 'set':
							unify(node, getThis(p.value))
							if (p.value.params.length >= 1) {
								unify(getNode(node).getPrty(name), p.value.params[0])
							}
							break;
					}
				})
				addPrototype(node, lookupPath("Object.prototype").key)
				return NOT_NULL
			case 'FunctionExpression':
				// TODO: track functions values
				visitStmt(node.body)
				return NOT_NULL
			case 'SequenceExpression':
				for (var i=0; i<node.expressions.length-1; ++i) {
					visitExpVoid(node.expressions[i])
				}
				unify(node, node.expressions.last())
				return visitExp(node.expressions.last(), void_ctx)
			case 'UnaryExpression':
				switch (node.operator) {
					case '+':
					case '~':
					case '-':
						visitExp(node.argument, NOT_VOID)
						assumeType(node, {type: 'number'})
						break;
					case '!':
						visitExp(node.argument, VOID)
						assumeType(node, {type: 'boolean'})
						break;
					case 'void':
						visitExp(node.argument, VOID)
						assumeType(node, {type: 'value', value: undefined})
						return NULL
					case 'typeof':
						visitExp(node.argument, VOID)
						assumeType(node, {type: 'string'})
						break;
					default:
						throw new Error("Unknown unary operator: " + node.operator)
				}
				return NOT_NULL
			case 'BinaryExpression':
				visitExpVoid(node.left, NOT_VOID)
				visitExpVoid(node.right, NOT_VOID)
				switch (node.operator) {
					case "==":
					case "!=":
					case "===":
					case "!==":
				    case "<":
				    case "<=":
				    case ">":
				    case ">=":
				    case "in":
				    case "instanceof":
				    	assumeType(node, {type: 'boolean'})
				    	break;

				    case "<<":
				    case ">>":
				    case ">>>":
				    case "-":
				    case "*":
				    case "/":
				    case "%":
				    case "|":
				    case "^":
				    case "&":
				    	assumeType(node, {type: 'number'})
				    	break;

				    case "+": // could be either number or string (TODO: handle this more precisely!)
				    	assumeType(node, {type: 'string'})
				    	assumeType(node, {type: 'number'})
				    	break;

				    default:
				    	throw new Error("Unknown binary operator: " + node.operator)
				}
				return NOT_NULL
			case 'AssignmentExpression':
				if (node.operator === '=') {
					visitExp(node.left, NOT_VOID)
					var r = visitExp(node.right, NOT_VOID)
					if (r !== NULL) {
						unify(node, node.left, node.right)
					}
					return r
				} else {
					visitExp(node.left, NOT_VOID)
					visitExp(node.right, NOT_VOID)
					unify(node, node.left)
					switch (node.operator) {
						case "+=":
							assumeType(node, {type: 'string'})
							assumeType(node, {type: 'number'})
							break;
						case "-=":
						case "*=":
						case "/=":
						case "%=":
						case "<<=":
						case ">>=" :
						case ">>>=":
						case "&=":
						case "|=":
						case "^=":
							assumeType(node, {type: 'number'})
							break;
						default:
							throw new Error("Unknown compound assignment operator: " + node.operator)
					}
					return NOT_NULL
				}
			case 'UpdateExpression':
				visitExp(node.argument, NOT_VOID)
				assumeType(node, {type: 'number'})
				return NOT_NULL
			case 'LogicalExpression':
				if (node.operator === '&&') {
					unify(node, node.right)
					visitExp(node.left, VOID)
					visitExp(node.right, void_ctx)
					return NOT_NULL
				} else {
					if (!void_ctx) {
						unify(node, node.left, node.right)
					}
					visitExp(node.left, void_ctx)
					visitExp(node.right, void_ctx)
					return NOT_NULL
				}
			case 'ConditionalExpression':
				visitExp(node.test, VOID)
				visitExp(node.consequent, void_ctx)
				visitExp(node.alternate, void_ctx)
				if (!void_ctx) {
					unify(node, node.consequent, node.alternate)
				}
				return NOT_NULL
			case 'NewExpression':
				return NOT_NULL; // TODO
			case 'CallExpression':
				return NOT_NULL; // TODO
			case 'MemberExpression':
				visitExp(node.object, NOT_VOID)
				if (node.computed) {
					visitExp(node.property, NOT_VOID)
					assumeType(node, {type: 'any'})
					// TODO: dynamic property access
				} else {
					unify(node, getNode(node.object).getPrty(node.property.name))
				}
				return NOT_NULL
			case 'Identifier':
				if (node.name === 'undefined') {
					assumeType(node, {type: 'value', value: undefined})
					return NULL
				}
				unify(node, getVar(node))
				return NOT_NULL
			case 'Literal':
				assumeType(node, {type: 'value', value: node.value})
				return node.value === null ? NULL : NOT_NULL
			case 'ThisExpression':
				unify(node, getThis(getEnclosingFunction(node)))
				return NOT_NULL
			default:
				throw new Error("Unknown expression: " + node.type)
		}
	}
	
	visitStmt(fun.body)

	unifier.complete()

	// add all nodes to list (those created by getPrty) and discard non-root nodes from list
	var newlist = []
	function addNodeToList(node) {
		node = node.rep()
		if ('$index' in node)
			return
		node.$index = newlist.length
		newlist.push(node)
		node.properties.forEach(function(name,dst) {
			addNodeToList(dst)
		})
	}
	unodes.forEach(addNodeToList)
	unodes = newlist // discard non-root elements

	propagateTypes(unodes)

	if (program.ptsDot) {
		var dotcode = pointsToDot(unodes)
		console.log(dotcode)
		process.exit(1)	
	}

	// check return type
	var node2type_compatible = Object.create(null)
	function isNodeCompatible(node, output, this_type) {
		node = node.rep()
		if (node.type.any)
			return true // fast return if node is any
		if (output.type === 'reference') {
			var h = node.$index + "~" + canonicalizeType(output)
			if (node2type_compatible[h])
				return node2type_compatible[h]
			node2type_compatible[h] = true // assume true for nested occurrences of this judgement
			return node2type_compatible[h] = isNodeCompatible(node, resolveTypeRef(output))
		}
		// TODO prototypes
		switch (output.type) {
			case 'object':
				for (var k in output.properties) {
					var inode = node.properties.get(k)
					if (inode) {
						if (!isNodeCompatible(inode, output.properties[k].type, )) {
							return false
						}
					} else {
						return node.type.some(function (t) {
							return lookupOnType(t, k).some(function(t) {
								return isTypeCompatible(t, output.properties[k].type)
							})
						})
					}
				}
				var callsOK = output.calls.all(function(oc) {
					// TODO: use tracked function value
					return node.type.some(function(t) {
						return isCallSatisfiedByType(oc, this_type, t)
					})
				})
				if (!callsOK)
					return false
				// TODO: check indexers and brands
				return true
			case 'string':
			case 'number':
				return node.type.some(function(t) {
					return isTypeCompatible(t, output)
				})
			case 'boolean':
				return true // boolean type is sometimes used as a "boolean-like value" so we can't do a useful check here
			case 'enum':
				return node.type.some(function(t) {
					return isTypeCompatible(t, output)
				})
			case 'void':
				return true // it's ok to return something if void was expected
			case 'any':
				return true // everything satisfies any
			case 'type-param':
				return true // TODO type-param
			default:
				throw new Error("isNodeCompatible " + output.type)
		}
	}
	var returnNode = call.new ? getThis(fun) : getReturn(fun)
	var isOK = isNodeCompatible(returnNode, call.returnType)

	return call_object_assumptions[h] = isOK
}



// ------------------------------------------------
// 		Points-to graph to Graphviz Dot
// ------------------------------------------------

function escapeLabel(lbl) {
	return lbl.replace(/[{}"<>]/g, '\\$&').replace(/\t/g,'\\t').replace(/\n/g,'\\n').replace(/\r/g,'\\r').replace(/\f/g,'\\f')
}

function pointsToDot(nodes) {
	var sb = []
	function println(x) {
		sb.push(x)
	}
	function formatUnionType(type) {
		if (type.any)
			return "any"
		else {
			var sb = []
			for (var k in type.table) {
				sb.push(formatType(type.table[k]))
			}
			return sb.join("|")
		}
	}
	println("digraph {")
	nodes.forEach(function(node) {
		println("  " + node.$index + ' [shape=box,label="' + escapeLabel(formatUnionType(node.type)) +  '"]')
		node.properties.forEach(function(name, dst) {
			dst = dst.rep()
			println("  " + node.$index + " -> " + dst.$index + " [label=\"" + escapeLabel(name) + "\"]")
		})
	})
	println("}")
	return sb.join('\n')
}

// ------------------------
// 		Entry Point
// ------------------------

function main() {
	// TODO: move loading of inputs into main function
	check(lookupQType(typeDecl.global,[]), {key: snapshot.global}, '', false, null, '<global>');
	if (program.suggest) {
		findSuggestions()
	}
	if (program.coverage) {
		printCoverage();
	}
}

main();
