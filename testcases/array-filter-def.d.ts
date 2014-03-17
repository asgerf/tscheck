declare function filter<T>(xs:T[], callback:(elm:T, index:number) => boolean): T[]
declare function bad<T>(xs:T[], callback:(elm:T, index:number) => boolean): string[]
