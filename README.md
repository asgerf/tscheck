About **tscheck**
=================

**tscheck** is a tool for finding bugs in hand-written TypeScript type definitions (`.d.ts` files). It works by comparing the type definitions to the actual JavaScript library implementation.

Installation
------------

 - Install [node.js](http://nodejs.org/) if you don't already have it.
 - Install [jsnap](https://github.com/asgerf/jsnap) and put `jsnap` on your PATH
 - Clone this repository 
 - `npm install` to install dependencies
 - We suggest adding `tscheck.js` to your PATH

Usage
-----

To check `foo.d.ts` against the library `foo.js`, run the command:

    tscheck foo.js foo.d.ts
    
Or simply:
    
    tscheck foo

Run `tscheck -h` for a list of options.

Output
------

tscheck prints a series of warnings, one warning per line, in no particular order.

The warnings have the format `foo.bar.baz: expected X but found Y`. This means the value one would get by evaluating the pseudo-expression `foo.bar.baz` was expected to have type `X`, but tscheck found something of type `Y` instead.

If there is no output, it means tscheck found no bugs in your `.d.ts` file. This does ***not*** guarantee that the type definitions are actually correct, it just means that tscheck could not find anything wrong.

In some cases, tscheck may get confused and report "false warnings", complaining about type definitions that are actually correct. tscheck apologizes for the inconvenience.


Performance
-----------

tscheck can take several minutes to complete. If you are impatient, pass the flag `--no-analysis`, this will perform a much faster check, but it will also find fewer bugs.

If you wish to check a specific part of the API, you can pass the flag `--path foo` to only check paths that contain the string `foo`; this will typically speed things up a lot.

If tscheck seems to get stuck, try passing `--expose-gc` to the node process. This alleviates a problem with the v8 garbage collector.

Note that even for tiny `.d.ts` files, tscheck still has a warm-up time of a few seconds due to parsing TypeScript's `lib.d.ts` file.

About **tscore**
============

**tscore** is a subsystem in tscheck which converts a `.d.ts` file into an instance of a much simpler structural type system, in which name resolution and inheritance have been fully resolved.

tscore is of no importance to most TypeScript users, but programming language enthusiasts working with TypeScript may find it useful.

The output of tscore is a JSON-like object following this informal specification:

```
type TypeScriptDeclarationFile = {
	global: string 	// name of global type in env
	env: StringMap[TypeDef]
	externs: StringMap[string] // external module names -> key in TypeEnv,
	enums: StringMap[EnumDef]
}

interace StringMap[T] = { // map from string to T
	[s:string]: T 	
}

// paths to values of enum, (eg. [Foo.X, Foo.Y, Foo.Z])
type EnumDef = Array[String] 

interface TypeDef {
	typeParameters: Array[string],
	object: ObjectType
}

type Type
	= ObjectType 
	| EnumType 
	| BuiltinType 
	| StringConstType 
	| TypeParamRef 
	| TypeRef

interface TypeRef {
	type: 'reference',
	name: string 	// index into type env
	typeArguments: Array[Type]
}
interface ObjectType {
	type: 'object'
	properties: StringMap[Property]
	calls: Array[Call]
	stringIndexer: Type | null
	numberIndexer: Type | null
	brand: string | null // path to constructor
	meta: {
		kind: 'module' | 'class' | 'interface'
		origin: string 			// which file contributed the type
	}
}
interface Property {
	optional: boolean
	type: Type
	meta: {
		origin: string  	     // which file contributed the property
	}
}
interface Call {
	new: boolean
	variadic: boolean
	typeParameters: Array[TypeParameter]
	parameters: Array[Parameter]
	returnType: Type
	meta: {
		implicit: boolean 	// true if default constructor
	}
}
}
interface Parameter {
	optional: boolean
	name: string
	type: Type
}
interface TypeParameter {
	name: string
	constraint: Type | null
}
interface EnumType {
	type: 'enum'
	name: string
}
interface BuiltinType {
	type: 'number' | 'string' | 'boolean' | 'void' | 'any'
}
interface StringConstType {
	type: 'string-const'
	value: string
}
interface TypeParamRef {
	type: 'type-param'
	name: string
}
```
