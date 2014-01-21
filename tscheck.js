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



// ------------------------------------------------------------
// 		 Recursive check of Value vs Type
// ------------------------------------------------------------

function isNumberString(x) {
	return x === String(Math.floor(Number(x)))
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
            break;
        case 'FunctionDeclaration':
            var parent = getEnclosingFunction(node.$parent); // note: use getEnclosingFunction, because fun decls are lifted outside catch clauses
            node.$env = new Map;
            node.$depth = 1 + parent.$depth;
            parent.$env.put(node.id.name, node.id)
            for (var i=0; i<node.params.length; i++) {
                node.$env.put(node.params[i].name, node.params[i])
            }
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

function numberSourceFileFunctions() {
	if (sourceFileAst === null)
		return
	var array = []
	function add(x) {
		x.$function_id = array.length;
		array.push(x)
	}
	function visit(node) {
		if (node.type === 'Program' || node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') {
			add(node)
		}
		children(node).forEach(visit)
	}
	visit(sourceFileAst)
	sourceFileAst.$id2function = array;
}

function numberNodes() {
	var id=0
	function visit(node) {
		node.$id = ++id;
		children(node).forEach(visit)
	}
	visit(sourceFileAst)
}

function prepareAST() {
	injectParentPointers(sourceFileAst)
	injectEnvs(sourceFileAst)
	numberSourceFileFunctions()	
	numberNodes()
}
if (sourceFileAst !== null) {
	prepareAST()
}

function findFunction(id) {
	if (sourceFileAst === null)
		return null;
	return sourceFileAst.$id2function[id]
}

function checkCallSignature(call, receiverKey, objKey, path) {
	var obj = lookupObject(objKey);
	if (!obj.function) {
		console.log(path + ": expected " + formatTypeCall(call) + " but found non-function object")
		return;
	}
	switch (obj.function.type) {
		case 'native':
		case 'unknown':
			break; // XXX: is there a need for something useful here?
		case 'bind':
			break; // TODO: support bound functions
		case 'user':
			var fun = findFunction(obj.function.id)

			if (!fun)
				return
			if (fun.params.length !== call.parameters.length) {
				console.log(path + ": function takes " + fun.params.length + " params but " + call.parameters.length + " were declared in call signature")
			}
			// console.log(path + ": function defined on line " + fun.loc.start.line)
			break;
	}
}

/**
	interface State {
		this: Value,
		variables: Map[Value],
		abstract: Map[AbstractObject]
	}
	type StmtResult = { state : State, terminator?: Terminator }
	type ExpResult = { state : State, value : Value }
	interface Terminator {
		type : 'break' | 'continue' | 'return'
		label?: string
		value?: Value
	}
	type AbstractObject = {
		id: number (ID for entire group)
		rank: number (for union by rank)
		value: Value (pointers to abstract object must not form a cycle)
	}
	
	\\\\
*/

function AbstractState() {
	this.variables = new Map
	this.abstract = new Map
}
AbstractState.prototype.var = function(name, value) {
	var k = '$' + name
	if (arguments.length > 1) {
		return this[k] = value
	}
	return this[k]
}
AbstractState.prototype.abstr = function(name, value) {
	var k = '#' + name
	if (arguments.length > 1) {
		return this[k] = value
	}
	return this[k]
}
AbstractState.prototype.hash = function() {
	if ('_hash' in this)
		return this._hash
	var bag = []
	this.variables.forEach(function(name,t) {
		bag.push(name + '=' + canonicalizeType(t))
	})
	this.abstract.forEach(function(name,t) {
		bag.push(name + '=' + canonicalizeType(t))
	})
	bag.sort()
	return this._hash = bag.join('|')
}
AbstractState.prototype.whenTrue = function(x) {
	if (typeof x === 'string') {
		
	}
}

var analysisMemo = Object.create(null);
function getMemo(node) {
	var memo = analysisMemo[node.$id];
	if (!memo) {
		analysisMemo[node.$id] = memo = Object.create(null);
	}
	return memo;
}
function fixp(node, state, fn) {
	var memo = getMemo(node)
	var h = state.hash()
	var result = memo[h]
	if (result)
		return result;
	memo[h] = []
	result = []
	function kontinue(r) {
		result.push(r)
	}
	function loop(state, k) {
		fixp(node,state,fn).forEach(k)
	}
	fn(state, kontinue, loop)
	memo[h] = result
	return result
}

function FunctionTooComplex() {}

function analyzeFunction(node, env, receiver, args) { // [ Value ]
	var variables = new Map
	node.params.forEach(function(param,i) {
		variables.put(param.name, args[i])
	})
	node.$env.forEach(function(name) {
		if (!variables.has(name)) {
			variables.put(name, {
				type: 'value',
				value: {type: 'void'}
			})
		}
	})
	while (env) {
		var envObj = lookupObject(env.key)
		envObj.properties.forEach(function(prty) {
			if (!variables.has(prty.name)) {
				variables.put(prty.name, {
					type: 'value',
					value: prty.value // note: environment objects cannot have getters/setters
				})
			}
		})
		env = envObj.env
	}
	var state = {
		this: receiver,
		variables: variables,
		abstract: new Map
	}
	try {
		analyzeStmtBlock(node.body, state)
	} catch (e) {
		if (e instanceof FunctionTooComplex) {
			return;
		} else {
			throw e;
		}
	}
}
function analyzeStmtBlock(nodes, state, k) { // [ { state : State, terminator?: Terminator } ]
	var states = [state]
	var result = []
	nodes.forEach(function(node) {
		var next = []
		states.forEach(function(state) {
			analyzeStmt(node, state).forEach(function(sr) {
				if (sr.terminator)
					result.push(sr)
				else
					next.push(sr)
			})
		})
		states = next
	})
	states.forEach(function(x) {
		k(x)
	})
	return result
}

function analyzeStmt(node, state, k) { // [ { state : State, terminator?: Terminator } ]
	var result
	if (typeof k === 'undefined') {
		result = []
		k = function(x) { result.push(x) }
	}
	switch (node.type) {
		case 'EmptyStatement':
			k( { state:state } )
			break;
		case 'BlockStatement':
			analyzeStmtBlock(node.body, state, k)
			break;
		case 'ExpressionStatement':
			analyzeExp(node.expression, state, function(er) { k(er.state) })
			break;
		case 'IfStatement':
			analyzeCondition(node.test, state, {
				whenTrue: function(er) {
					analyzeStmt(node.consequent, er.state, k)
				},
				whenFalse: function(er) {
					analyzeOptStmt(node.alternate || null, er.state, k)
				}
			}
			break;
		case 'LabeledStatement':
			analyzeStmt(node.body, state, function(sr) {
				if (sr.terminator && sr.terminator.type === 'break' && sr.terminator.label == node.label.name) {
					k({state: sr.state})
				} else {
					k(sr)
				}
			})
			break;
		case 'WhileStatement':
			fixp(node, state, function(state, kontinue, loop) {
				analyzeCondition(node.test, state, {
					whenTrue: function(er) {
						analyzeStmt(node.body, er.state, function(sr) {
							if (sr.terminator)
								kontinue(sr)
							else
								loop(sr.state, kontinue)
						})
					},
					whenFalse: function(er) {
						kontinue({state: er.state})
					}
				})
			}).forEach(k)
			break;
		case 'DoWhileStatement':
			fixp(node, state, function(state, kontinue, loop) {
				analyzeStmt(node.body, state, function(sr) {
					if (sr.terminator)
						kontinue(sr)
					else {
						analyzeCondition(node.test, er.state, {
							whenTrue: function(er) {
								loop(er.state, kontinue)
							},
							whenFalse: function(er) {
								kontinue({state: er.state})
							}
						})
					}
				})
			}).forEach(k)
			break;
		case 'BreakStatement':
			k({ state: state,
				terminator: { type: 'break', label: node.label.name } })
			break;
		case 'ReturnStatement':
			if (!node.argument) {
				k({
					state: state,
					terminator: {
						type: 'return',
						value: { type: 'void' }
					}
				})
			} else {
				analyzeExp(node.argument, state, function(er) {
					k({ 
						state: er.state,
						terminator: {
							type: 'return',
							value: er.value
						}
					})
				})
			}
			break;
		case 'ThrowStatement':
			analyzeExp(node.argument, state, function(er) {
				k({
					state: er.state,
					terminator: {
						type: 'throw'
					}
				})
			})
			break;
		case 'VariableDeclaration':
		 	var states = [state]
		 	node.declarations.forEach(function(decl) {
		 		if (!decl.init) {
		 			return; // environments have already been built; vars without initializers are now considered no-ops
		 		}
		 		var nextStates = []
		 		var name = decl.id.name
		 		states.forEach(function(state) {
		 			analyzeExp(decl.init, state).forEach(function(er) {
		 				var newState = updateVariable(name, er.value, er.state)
		 				nextStates.push(newState)
		 			})
		 		})
		 		states = nextStates
		 	})
		 	return states.map(function(state) {
		 		return {state:state}
		 	})
		case 'ForInStatement':
			throw new FunctionTooComplex
		case 'WithStatement':
			throw new FunctionTooComplex
		case 'TryStatement':
			throw new FunctionTooComplex
		case 'FunctionDeclaration':
			throw new Error("Inner functions not supported")
		default:
			throw new Error("Unrecognized statement: " + (node.type || util.inspect(node)))
	}
	return result
}
function analyzeOptStmt(node, state, k) {
	if (!node)
		return k({state:state})
	else
		return analyzeStmt(node,state,k)
}
var EmptyObjectType = {
	type: 'object',
	properties: {},
	calls: [],
	stringIndexer: null,
	numberIndexer: null,
	meta: {kind: 'interface'}
}
function analyzeExp(node, state, k) { // [ { state : State, value : Value } ]
	switch (node.type) {
		case 'ThisExpression':
			k({state:state, value:state.this()})
			break;
		case 'ArrayExpression':
			function visitArray(i, state, values) {
				if (i === node.elements.length) {
					var t = bestCommonType(values)
					k({state: state, value: {type: 'reference', name:'Array', typeArguments:[t]})
				} else if (node.elements[i] === null) {
					visitArray(i+1, state);
				} else {
					analyzeExp(node.elements[i], function(er) {
						visitArray(i+1, er.state, values.concat([er.value]))
					})
				}
			}
			visitArray(0, state, values)
			break;
		case 'ObjectExpression':
			var statexs = [{
				state: state,
				properties: new Map
			}]
			node.properties.forEach(function(prty) {
				if (prty.kind !== 'init')
					throw new Error("Getters/setters are not supported")
				var nextStatexs = []
				var name = prty.key.type === 'Literal' ? prty.key.value : prty.key.name
				statexs.forEach(function(stx) {
					analyzeExp(prty.value, stx.state).forEach(function(er) {
						var prtys = stx.properties.clone()
						prtys.put(name, er.value)
						nextStatexs.push({
							state: er.state,
							properties: prtys
						})
					})
				})
				statexs = nextStatexs
			})
			// XXX: treat properties with literal names as stringIndexer and numberIndexer entries?
			var result = []
			statexs.forEach(function(stx) {
				var t = { 
					type:'object', 
					properties: stx.properties.json(),
					calls: [],
					stringIndexer: null,
					numberIndexer: null,
					meta: {kind:'interface'}
				}
				refineAbstract(stx.state, node.$id, t).forEach(function(state) {
					result.push({
						state: newState,
						value: { type: 'abstract', value: node.$id }
					})
				})
			})
			return result
		case 'FunctionExpression':
			throw new Error("Inner function expressions not supported")
		case 'SequenceExpression':
			var statexs = [{
				state: state,
				value: null
			}]
			node.expressions.forEach(function(exp) {
				var nextStatexs = []
				statexs.forEach(function(stx) {
					analyzeExp(exp, stx.state).forEach(function(er) {
						nextStatexs.push({
							state: er.state,
							value: er.value
						})
					})
				})
				statexs = nextStatexs
			})
			return statexs
			/*
			x = {}@1
			while (..) {
				// [x -> @1, @1 -> {}], [x -> @2, @1 -> {}, @2 -> {f:@1}]
				x = {f:x}@2
				// [x -> @2, @1 -> {}, @2 -> {f:@1}], [x -> @1+2, @1+2 -> {f?:@1+2}]
			}
			[x -> @1+2, @1+2 -> {f? : @1+2}]
			*/
	}
}
function analyzeCondition(node, state) { // { whenTrue : ExpResult, whenFalse : ExpResult }
	// TODO
}

function bestCommonType(types) {
	// TODO
}
function updateVariable(name, value, state) {
	var vars = state.variables.clone()
	vars.put(name,value)
	return {
		this: state.this,
		variables: vars,
		abstract: state.abstract
	}
}
function defineAbstract(state, id, value) {
	var abstr = state.abstract.clone()
	abstr.put(id, value)
	return {
		this: state.this,
		variables: state.variables,
		abstract: abstr
	}
}
function refineAbstract(state, id, value) {
	// ?? {f:T, }

}
function unionTypes(state, t1, t2) {

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
