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
		case 'value':
			if (x.value && typeof x.value === 'object') {
				var obj = lookupObject(x.value.key)
				var t = {type: 'object', properties: {}, calls: [], stringIndexer: null, numberIndexer: null}
				obj.propertyMap.forEach(function(prty) {
					t.properties[prty.name] = {
						optional: false,
						type: { type: 'value', value: prty.value }
					}
				})
				return t
			}
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


// --------------------------
// 		Static Analysis
// --------------------------

var cfg = sourceFileAst && jsctrl(sourceFileAst)

function getFunction(id) {
	return cfg.functions[id]
}

var Keys = {
	this: 0,
	this_function: 1,
	arguments_array: 2,
	current_env: '!env',
	parameter: function(index) {
		return index + 3
	}
	local: function(id) {
		return id
	},
	prty: function(object,name) {
		return object + '.' + name
	},
	env: function(object) {
		return object + '!env'
	}
}

function AbstractState() {
	this.heap_counter = 0;
}
AbstractState.prototype.get = function(key) {
	return this[key]
}
AbstractState.prototype.put = function(key, value) {
	this[key] = value
}
AbstractState.prototype.nextHeapLocation = function() {
	return snapshot.heap.length + this.heap_counter++;
}
AbstractState.prototype.clone = function() {
	var result = new AbstractState
	for (var k in this) {
		if (this.hasOwnProperty(k)) {
			result[k] = this[k]
		}
	}
	return result
}


function checkCallSignature(call, receiverKey, functionKey, path) {
	var functionObj = lookupObject(functionKey)
	if (!functionObj.function) {
		console.log(path + ": expected " + formatTypeCall(call) + " but found non-function object")
		return
	}
	if (!cfg)
		return // cannot analyze function without source code
	switch (functionObj.function.type) {
		case 'user':
			var fun = getFunction(functionObj.function.id)
			if (!fun.blocks)
				return // function uses unsupported feature
			var state = new AbstractState
			state.put(Keys.this, {type: 'value', value: {key: receiverKey}})
			state.put(Keys.this_function, {type: 'value', value: {key: functionKey}})
			state.put(Keys.arguments_array, {type: 'any'}) // TODO: model arguments array?
			for (var i=0; i<fun.num_parameters; i++) {
				var t = i < call.parameters.length ? call.parameters[i].type : {type: 'value', value: undefined}
				state.put(Keys.parameter(i), t)
			}
			var envKey = state.nextHeapLocation()
			cfg.variables.forEach(function(varName) {
				state.put(Keys.prty(envKey, varName), {type: 'value', value: undefined})
			})
			state.put(Keys.env(envKey), {type: 'value', value: functionObj.env})
			state.put(Keys.current_env, {type: 'value', value: {key: envKey}})
			var outputState = analyzeFunction(f,state)
			break;
		case 'bind':
			break; // TODO: check bound functions
		case 'native':
		case 'unknown':
			break;
	}
}

function analyzeFunction(f, initialState) { // returns new state
	var block2state = [initialState]
	var worklist = [0]
	while (worklist.length > 0) {
		var blockidx = worklist.pop()
		var block = f.blocks[blockidx]
		var state = block2state[blockidx].clone()
		for (var i=0; i<block.statements.length; ++i) {
			analyzeStmt(block.statements[i], state)
		}
	}
}
function analyzeStmt(stmt, state) { // mutates state
	function lookupVariable(varName) {
		var env = state.get(Keys.current_env).key
		while (true) {
			var value = state.get(Keys.prty(env,varName))
			if (value) {
				return {env:env, value:value}
			}
			if (env < snapshot.heap.length) {
				var heapEnv = lookupObject(env)
				var prty = heapEnv.propertyMap.get(varName)
				if (prty) {
					return {env:env, value:{type:'value', value:prty.value}}
				}
				if (heapEnv.env) {
					env = heapEnv.env.key
				} else {
					return env // reached global object
				}
			} else {
				env = state.get(Keys.env(env)).key
			}
		}
	}
	function resolvePrty(prty) {
		if (typeof prty === 'string')
			return {type: 'value', value: string}
		var v = state.get(Keys.local(prty))
		return abstractToString(v)
	}
	switch (stmt.type) {
		case 'read-var':
			var v = lookupVariable(stmt.var)
			state.put(Keys.local(stmt.dst), v.value)
			break;
		case 'write-var':
			var v = lookupVariable(stmt.var)
			state.put(Keys.prty(v.env, stmt.var), state.get(Keys.local(stmt.src)))
			break;
		case 'assign':
			state.put(Keys.local(stmt.dst), state.get(Keys.local(stmt.src)))
			break;
		case 'load':
			var objType = state.get(Keys.local(stmt.object))
			objType = abstractToObject(objType)
			var prtyNameV = resolvePrty(stmt.prty)
			var v;
			if (prtyNameV.type === 'value' && typeof prtyNameV.value === 'string') {
				var name = prtyNameV.value
				switch (objType.type) {
					case 'value':
						var objKey = objType.value.key
						v = state.get(Keys.prty(objKey,name))
						if (!v && objKey < heap.snapshot.length) {
							var obj = lookupObject(objKey)
							var prty = obj.propertyMap.get(name)
							if ('value' in prty) {
								v = {type: 'value', value: prty.value}
							}
						}
						break;
					case 'object':
						var prty = objType.properties[name]
						if (prty) {
							v = prty.type
						}
						break;
				}
			} else {
				// TODO: lookup of unknown property (use indexers)
			}
			if (!v) {
				v = {type: 'any'}
			}
			state.put(Keys.local(stmt.dst), {type: 'any'})
			break;
		case 'store':
			var objType = state.get(Keys.local(stmt.object))
			objType = abstractToObject(objType)
			var prtyNameV = resolvePrty(stmt.prty)
			var v = state.get(Keys.local(stmt.src))
			if (prtyNameV.type === 'value' && typeof prtyNameV.value === 'string') {
				var name = prtyNameV.value
				switch (objType.type) {
					case 'value':
						var objKey = objType.value.key
						state.put(Keys.prty(objKey,name), v)
						break;
					case 'object':
						// TODO: check type of v vs object type?
						break;
				}
			}
			break;
		case 'const':
			state.put(Keys.local(stmt.dst), {type: 'value', value: stmt.value})
			break;
		case 'create-object':
			// ignore termination issues for now
			var id = state.nextHeapLocation()
			stmt.properties.forEach(function(prty) {
				if (prty.type === 'value') {
					state.put(Keys.prty(id,prty.name), state.get(Keys.local(prty.value)))
				}
			})
			state.put(Keys.local(stmt.dst), {type: 'value', value: {key: id}})
			break;
		case 'create-array':
		case 'create-function':
		case 'call-method':
		case 'call-function':
		case 'call-constructor':
		case 'unary':
		case 'binary':
	}
}

function abstractToObject(v) {
	switch (v.type) {
		case 'value':
			return {type: 'value', value: coerceToObject(v.value)}
		case 'object':
			return v
		case 'reference':
			return lookupQType(v.name, v.typeArguments)
		case 'number':
			return {type: 'value', value: NumberPrototype}
		case 'string':
			return {type: 'value', value: StringPrototype}
		case 'boolean':
			return {type: 'value', value: BooleanPrototype}
		default:
			return v
	}
}

function abstractType(x) {
	switch (x.type) {
		case 'value': 
			if (x.value === null)
				return 'null'
			else if (typeof x.value === 'function')
				return 'object'
			else
				return typeof x.value
		case 'reference': return 'object'
		case 'enum': return 'any'
		default: return x.type
	}
}
function abstractEqual(x, y, strict) {
	if (x.type === 'value' && y.type === 'value') {
		if (x.value && typeof x.value === 'object' && y.value && typeof y.value === 'object') {
			return {type: 'value', value: x.value.key === y.value.key}
		}
		return {type: 'value', value: strict ? x.value === y.value : x.value == y.value}
	}
	if (y.type === 'value' || y.type === 'enum') {
		var z = x; x = y; y = z; // swap x/y, so x is the value and y is the abstract type
	}
	// FIXME: handle enum types
	var xt = abstractType(x)
	var yt = abstractType(y)
	if (xt === 'any' || yt === 'any')
		return {type: 'boolean'}
	if (xt !== yt && strict)
		return {type: 'value', value: false} // values of different types cannot be strictly equal
	// abstract types: string, number, boolean, void, object, null   (null only for value types)
	if (x.type === 'value') {
		// value-type comparison
		switch (xt + '-' + yt) {
			// String value vs type
			case 'string-number': 
			case 'string-boolean': 
				if (isNumberLikeString(x.value))
					return {type: 'boolean'}
				else
					return {type: 'value', value: false}
			case 'string-object':
			case 'string-void':
			case 'string-string':
				return {type: 'boolean'}

			// Number value vs type
			case 'number-string':
				return {type: 'boolean'}
			case 'number-boolean':
				if (x.value === 0 || x.value === 1)
					return {type: 'boolean'}
				else
					return {type: 'value', value: false}
			case 'number-void':
				return {type: 'value', value: false}
			case 'number-object':
				if (y.brand === 'Number' || y.brand === 'Boolean' || y.brand === 'Array')
					return {type: 'boolean'} // 0 == [], 1 == [1], 1 == new Number(1)
				else
					return {type: 'value', value: false}
			case 'number-number':
				return isNaN(x.value) ? {type: 'value', value:false} : {type: 'boolean'}

			// Boolean value vs type
			case 'boolean-string':
			case 'boolean-number':
				return {type: 'boolean'}
			case 'boolean-void':
				return {type: 'value', value: false}
			case 'boolean-object':
				if (y.brand === 'Number' || y.brand === 'Boolean' || y.brand === 'Array')
					return {type: 'boolean'} // false == [], true == [1], true == new Boolean(1)
				else
					return {type: 'value', value: false}
			case 'boolean-boolean':
				return {type: 'boolean'}


			// Object value vs type
			case 'object-number:'
			case 'object-boolean:'
				if (hasBrand(x.value, 'Number') || hasBrand(x.value, 'Boolean') || hasBrand(x.value, 'Array'))
					return {type: 'boolean'}
				else
					return {type: 'value', value: false}
			case 'object-void':
				return {type: 'value', value: false}
			case 'object-string':
				return {type: 'boolean'}
			case 'object-object': // TODO: check against type for compatibility?
				return {type: 'boolean'}

			case 'null-string':
			case 'null-number':
			case 'null-boolean':
			case 'null-object':
				return {type: 'boolean'} // y could be null since null satisfies all types

			case 'null-void':
				return {type: 'value', value: true} // null == null and null == undefined
		}
	} else {
		// type-type comparison
		switch (xt + '-' + yt) {
			case 'string-number': 
			case 'string-boolean': 
			case 'string-object':
			case 'string-void':
				return {type: 'boolean'}
			case 'string-string':

			case 'number-string':
			case 'number-boolean':
			case 'number-void':
			case 'number-object':
			case 'number-number':
				return {type: 'boolean'}

			case 'boolean-string':
			case 'boolean-number':
			case 'boolean-void':
			case 'boolean-object':
			case 'boolean-boolean':
				return {type: 'boolean'}

			case 'object-number:'
			case 'object-string:'
			case 'object-boolean:'
			case 'object-void':
			case 'object-object': // TODO: check types for compatibility?
				return {type: 'boolean'}

			case 'void-number':
			case 'void-boolean':
			case 'void-string':
			case 'void-object':
				return {type: 'boolean'}
			case 'void-void':
				return {type: 'value', value: true}
		}
	}
	throw new Error("Unhandled case in abstractEqual")
}
function abstractNegate(x) {
	switch (x.type) {
		case 'value':
			return {type: 'value', value: !x.value}
		case 'boolean':
			return x;
		case 'void':
			return {type: 'value', value: true}
		default:
			return {type: 'boolean'}
	}
}
function abstractCompare(x, y, operator) {
	switch (x.type + '-' + y.type) {
		case 'value-value':
			if (x.value && typeof x.value === 'object' || y.value && typeof y.value === 'object') {
				return {type: 'boolean'}
			}
			var r;
			switch (operator) {
				case '<=': r = x.value <= y.value; break;
				case '<': r = x.value < y.value; break;
				case '>': r = x.value > y.value; break;
				case '>=': r = x.value >= y.value; break;
			}
			return {type: 'value', value: r}

		case 'number-number':
		case 'string-string':
			return {type: 'boolean'}

		default:
			return {type: 'value', value: false}
	}
}
function abstractPlus(x, y) {
	if (x.type === 'value' && y.type === 'value')  {
		var r = x.value + y.value
		if (r === 0 || r === 1 || r === -1 || r === '' || r === x.value || r === String(x.value) || r === y.value || r === String(y.value))
			return {type: 'value', value: r}
	}
	switch (abstractType(x) + '-' + abstractType(y)) {
		case 'number-number':
			return {type: 'number'}
		case 'string-string':
			return {type: 'string'}
		default:
			return {type: 'string'}
	}
}
function abstractArithmetic(x, y, operator) {
	if (x.type === 'value' && typeof x.value === 'number' && y.type === 'value' && typeof y.value === 'number') {
		var r;
		switch (operator) {
			case '<<': r = x.value << y.value; break;
			case '>>': r = x.value >> y.value; break;
			case '>>>': r = x.value >>> y.value; break;
			case '-': r = x.value - y.value; break;
			case '*': r = x.value * y.value; break;
			case '/': r = x.value / y.value; break;
			case '%': r = x.value % y.value; break;
			case '^': r = x.value ^ y.value; break;
			case '|': r = x.value | y.value; break;
			case '&': r = x.value & y.value; break;
		}
		if (r === 0 || r === 1 || r === -1 || r === x.value || r === y.value)
			return {type: 'value', value: r}
		else
			return {type: 'number'} // widen to ensure termination
	}
	return {type: 'number'}
}
function abstractInstanceof(x,y) {
	if (x.type === 'value' && y.type === 'value') {
		var prty = lookupObject(y.value.key).propertyMap.get("prototype")
		if (!prty) {
			return null // TypeError at runtime
		}
		if (!('value' in prty))
			return {type: 'boolean'} // prototype hidden behind getter
		var proto = prty.value
		var v = x.value
		while (v && typeof v === 'object') {
			if (valuesStrictEq(v,proto))
				return {type: 'value', value: true}
			v = lookupObject(v.key).prototype
		}
		return {type: 'value', value: false}
	}
	if (y.type === 'value') {
		// TODO: check against type of left operand
		return {type: 'boolean'}
	}
	if (x.type === 'value') {
		// TODO: check against type of right operand
		return {type: 'boolean'}
	}
	// TODO: check compatibility of types
	return {type: 'boolean'}
}
function abstractIn(x, y) {
	if (y.type === 'value') {
		if (y.value === null)
			return null // throws exception
		if (typeof y.value !== 'object')
			return null
		x = abstractToString(x)
		if (x.type === 'value') {
			var obj = lookupObject(y.key)
			return {type: 'value', value: obj.propertyMap.has(x.value)}
		} else {
			return {type: 'boolean'}
		}
	} else if (y.type === 'object') {
		x = abstractToString(x)
		if (x.type === 'value') {
			if (x.value in y.properties)
				return {type: 'value', value: true}
			if (x.stringIndexer || x.numberIndexer)
				return {type: 'boolean'}
			return {type: 'value', value: false}
		} else {
			return {type: 'boolean'}
		}
	} else {
		return null;
	}
}
function abstractToString(x) {
	if (x.type !== 'value')
		return {type: 'string'}
	switch (typeof x.value) {
		case 'number':
			return {type: 'value', value: String(x.value)}
		case 'string':
			return x
		case 'boolean':
			return {type: 'value', value: (x.value ? 'true' : 'false')}
		case 'undefined':
			return {type: 'value', value:'undefined'}
		case 'object':
			return (x === null) ? {type: 'value', value:'null'} : {type: 'string'}
		case 'function':
			return {type: 'string'}
		default:
			return {type: 'string'}
	}
}


// --------------------------
// 		Entry Point
// --------------------------

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
