let config = {
    interval: 10,
    measurements: 6,
    dtu: {
        ip: "xxx.xxx.xxx.xxx",
        user: "admin",
        pwd: "xxxxxx",
        inverter: 0,
        serial: "xxxxxxxxxxxx"
    },
    meter: {
        id: 0,
        phase: "b"
    },
    target: -750,
    limit: {
        min: 800,
        max: 1500,
        maxDeviation: 25
    },
    increase: {
        threshold: -700,
        min: 25,
        max: 50
    },
    decrease: {
        threshold: -770,
        min: -10,
        max: -700,
        safety: -100
    },
    buffer: {
        min: 100,
        target: 200,
        max: 300
    },
    round: 10
};


let data = {
    limit: {
        last: undefined,
        act: undefined,
        max: undefined,
        values: []
    },
    prod: {
        act: undefined,
        max: undefined,
        values: []
    },
    grid: {
        act: undefined,
        min: undefined,
        values: []
    }
};



function ceil(value) {
    return Math.ceil(value / (config.round || 1)) * (config.round || 1);
}

function floor(value) {
    return Math.floor(value / (config.round || 1)) * (config.round || 1);
}

function isSignificantDiff(a, b) {
    return Math.abs(a - b) >= (config.round || 0);
}

function rangeLimit(value) {
    return Math.round(Math.max(config.limit.min, Math.min(config.limit.max, value)));
}

function getActGrid() {
	let shelly = Shelly.getComponentStatus("EM", config.meter.id || 0);	
  if (!shelly || typeof shelly !== "object" || typeof shelly[config.meter.phase + "_act_power"] !== "number") {
    print("ERROR: Shelly power unkown");
    return undefined;
  } 
  return shelly[config.meter.phase + "_act_power"] || 0;
}

function onSetInverterLimitResponse(result, error_code, error_message, limit) {
    if(typeof result !== "object" || typeof result.code !== "number" || result.code !== 200) {
        result = null;
        data.limit.last = data.limit.act || null;
        print("ERROR: Limit not set");
        return;
    }
    result = null;
    data.limit.last = limit;
    print("Success: New limit set to " + limit);
    return;
}


// Set Inverter Limit
function setInverterLimit(limit) {
    if(typeof config.dtu.serial !== "string") {
        data.limit.last = null;
        print("missing inverter serial. can not set limit")
        return;
    }
    Shelly.call(
        'HTTP.POST', {
            url: "http://" + (config.dtu.user || "admin") + ":" + config.dtu.pwd + "@" + config.dtu.ip + "/api/limit/config",
            body: "data={\"serial\":\"" + config.dtu.serial + "\",\"limit_type\":0,\"limit_value\":" + limit + "}",
            content_type: "application/x-www-form-urlencoded",
            ssl_ca: "*",
            timeout: Math.max(5, (config.interval || 10) - 5)
        }, onSetInverterLimitResponse, limit);
}



function updateLimit(limit, offset, fast) {

    // Last set limit
    data.limit.last = data.limit.last || data.limit.act || null;

    // Too big deviation between inverter limit act and last stored set value?
    if(!data.limit.last || (Math.abs(data.limit.last - data.limit.act) > Math.abs(config.limit.maxDeviation))) {
        data.limit.last = data.limit.act || null;
    }

    // Calculate new limit
    let newLimit = ((typeof limit === "number") && (limit >= 0))
        // Fixed value?
        ?
        rangeLimit(ceil(limit + (typeof offset === "number" ? offset : 0)))
        // Automatic calculation
        :
        rangeLimit(
            ceil(Math.min(
                    // Reach grid feed target
                    data.limit.last + data.grid.min - config.target,
                    // do not exceed buffer
                    data.prod.act + config.buffer.target
                )
                // apply optional buffer
                +
                (typeof offset === "number" ? offset : 0)
            )
        );


    // Default: increase/decrease in steps
    if((fast !== true) && (typeof data.limit.last === "number")) {

        let limitChange = newLimit - data.limit.last;
        limitChange = limitChange < 0
            // Decrease
            ?
            (limitChange <= config.decrease.min ?
                Math.max(limitChange, config.decrease.max) :
                0
            ) :
            limitChange > 0 ?
            limitChange >= config.increase.min ?
            Math.min(limitChange, config.increase.max) :
            0 :
            0;

        newLimit = rangeLimit(ceil(data.limit.last + limitChange));
    }


    // Update of limit required?
    if(
        (typeof data.limit.last !== "number") ||
        isSignificantDiff(newLimit, data.limit.last)
    ) {
        data.limit.last = newLimit;
        print("Set limit: " + newLimit);
        setInverterLimit(newLimit);
    } else {
        print("Keep actual limit");
    }


}

function onResponseDTU(result) {

    // Rolling Min/Max Measurments - remove oldest value              
    data.limit.values = (data.limit.values || []).slice(-(config.measurements - 1));
    data.prod.values = (data.prod.values || []).slice(-(config.measurements - 1));
    data.grid.values = (data.grid.values || []).slice(-(config.measurements - 1));


    // Invalid inverter data? Set min. Limit!  	
    if(typeof result !== "object" || typeof result.code !== "number" || result.code !== 200 || typeof result.body !== "string") {
        print("ERROR: No DTU data.");
        return;
    }

    let dtu = JSON.parse(result.body);

    result = null;

    //override serial
    config.dtu.serial = dtu.inverters[config.dtu.inverter || 0].serial || config.dtu.serial;

    // Inverter not reachable? Set min. Limit!          
    if(!(dtu.inverters[config.dtu.inverter || 0].reachable || false)) {
        print("DTU is not reachable.");
        //					return updateLimit(config.limit.min, 0, true);
    }


    //Limit, Prod & Grid
    data.limit.act = Math.round(dtu.inverters[config.dtu.inverter || 0].limit_absolute || 0);
    data.prod.act = Math.round(dtu.inverters[config.dtu.inverter || 0].AC[0].Power.v || 0);

    dtu = null;
    data.grid.act = Math.round(getActGrid());




    // Invalid data?
    if((typeof data.limit.act !== "number") ||
        (typeof data.prod.act !== "number") ||
        (typeof data.grid.act !== "number")) {

        // remove oldest data --> empty history after x runs
        data.limit.values = (data.limit.values || []).slice(1);
        data.prod.values = (data.prod.values || []).slice(1);
        data.grid.values = (data.grid.values || []).slice(1);

        print("Invalid measurement data");
        return updateLimit(config.limit.min, 0, true);
    };

    // Add values to history                          
    data.limit.values.push(data.limit.act);
    data.prod.values.push(data.prod.act);
    data.grid.values.push(data.grid.act);

    if((data.limit.values.length !== config.measurements) ||
        (data.prod.values.length !== config.measurements) ||
        (data.prod.values.length !== config.measurements)
    ) {
        print("Too few data");
        return updateLimit(config.limit.min, 0, true);
    }

    //Ceil or floor actuals     
    data.limit.act = ceil(data.limit.act);
    data.prod.act = ceil(data.prod.act);
    data.grid.act = floor(data.grid.act);


    // Calc min/max values
    data.limit.max = ceil(Math.max.apply(null, data.limit.values));
    data.prod.max = ceil(Math.max.apply(null, data.prod.values));
    data.grid.min = floor(Math.min.apply(null, data.grid.values));


    let bufferAct = Math.max(0, data.limit.act - data.prod.act);



    // Limit below minimum? Set min. Limit!  
    if(data.limit.act < config.limit.min) {
        print("Below minimimum Limit");
        return updateLimit(config.limit.min, 0, true);
    }

    // Limit below threshold? Decrease!
    if(data.grid.min <= config.decrease.threshold) {
        print("Too high grid feed");
        return updateLimit(null, config.decrease.safety, false);
    }

    // Buffer too big? Decrease!
    if(bufferAct >= config.buffer.max) {
        print("Too big buffer");
        return updateLimit(null, 0, false);
    }

    // Below grid threshold or buffer too small? Increase!
    if((data.grid.min >= config.increase.threshold) &&
        (bufferAct <= config.buffer.min)
    ) {
        print("Limit too low");
        return updateLimit(null, 0, false);
    }

    //Nothing todo                          
    print("Limit ok");

};


// Get inverter and shelly data
function evaluateMeasurements(fn) {
    Shelly.call('HTTP.GET', {
            url: "http://" + (config.dtu.user || "admin") + ":" + config.dtu.pwd + "@" + config.dtu.ip + "/api/livedata/status",
            timeout: Math.max(5, (config.interval || 10) - 5),
            ssl_ca: "*"
        },
        onResponseDTU
    );
}




print("Start");

// Set minimum Limit on startup
updateLimit(config.limit.min, 0, true);

// Schedule Timer for regular check
Timer.set((config.interval || 10) * 1000, true, evaluateMeasurements);
