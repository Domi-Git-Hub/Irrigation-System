const fs = require("fs");
const path = require("path");
const storage = require("node-persist");
const { spawn } = require("child_process");
const fetch = require("node-fetch");
const express = require("express");
const rateLimit = require("express-rate-limit");

const packageJson = require("../package.json");
const options = require("./utils/options.js");


const app = express();
let Service, Characteristic, storagePath;

module.exports = function (homebridge) {
	Service = homebridge.hap.Service;
	Characteristic = homebridge.hap.Characteristic;
	storagePath = homebridge.user.storagePath();

	homebridge.registerAccessory(
		"homebridge-irrigation-system",
		"irrigation-system",
		Irrigation
	);
};

function Irrigation(log, config) {
	this.log = log
	this.config = config
	this.zones = config.zones;
	this.zoned = this.zones.length || 1
	this.accessoryValve = []
	this.zoneDuration = []
	this.zoneTimeEnd = []
	this.accessorySwitch = []
	this.timeOut = []
	this.ChargingState = Characteristic.ChargingState.NOT_CHARGING
	
	this.service = new Service.IrrigationSystem(config.name)
	this.service
		.setCharacteristic(Characteristic.ProgramMode, Characteristic.ProgramMode.NO_PROGRAM_SCHEDULED)
		.setCharacteristic(Characteristic.Active, Characteristic.Active.ACTIVE)
		.setCharacteristic(Characteristic.InUse, Characteristic.InUse.NOT_IN_USE)
		.setCharacteristic(Characteristic.StatusFault, Characteristic.StatusFault.NO_FAULT)
		.setCharacteristic(Characteristic.RemainingDuration, 0)
		.setCharacteristic(Characteristic.WaterLevel, 100)	

	// Accessory information
	this.accessoryInformationService = new Service.AccessoryInformation();

	this.accessoryInformationService.setCharacteristic(
		Characteristic.Identify,
		true
	);
	this.accessoryInformationService.setCharacteristic(
		Characteristic.Manufacturer,
		"Domi"
	);
	this.accessoryInformationService.setCharacteristic(
		Characteristic.Model,
		"DIY"
	);
	this.accessoryInformationService.setCharacteristic(
		Characteristic.Name,
		"homebridge-irrigation"
	);
	this.accessoryInformationService.setCharacteristic(
		Characteristic.SerialNumber,
		"S3CUR1TYSYST3M"
	);
	this.accessoryInformationService.setCharacteristic(
		Characteristic.FirmwareRevision,
		packageJson.version
	);

	// Services list
	this.services = [this.service, this.accessoryInformationService];

	for (let zone = 1; zone <= this.zoned; zone++) {
		this.zoneDuration[zone] = this.zones[zone - 1].setDuration * 60
		this.zoneTimeEnd[zone] = 0
		
		this.accessoryValve[zone] = new Service.Valve(this.zones[zone - 1].zonename, zone)
			
		this.accessoryValve[zone]
			.setCharacteristic(Characteristic.Active, Characteristic.Active.INACTIVE)
			.setCharacteristic(Characteristic.InUse, Characteristic.InUse.NOT_IN_USE)
			.setCharacteristic(Characteristic.ValveType, Characteristic.ValveType.IRRIGATION)
			.setCharacteristic(Characteristic.SetDuration, this.zones[zone - 1].setDuration * 60)
			.setCharacteristic(Characteristic.RemainingDuration, 0)
			.setCharacteristic(Characteristic.ServiceLabelIndex, zone)
			.setCharacteristic(Characteristic.Name, this.zones[zone - 1].zonename)
			.setCharacteristic(Characteristic.ConfiguredName, "Zone " + String(zone) + " " + this.zones[zone - 1].zonename)
			.setCharacteristic(Characteristic.IsConfigured, Characteristic.IsConfigured.CONFIGURED)
		this.accessoryValve[zone]
			.getCharacteristic(Characteristic.Active)
			.onGet(this.getOnHandlerValve.bind(this, zone))
			.onSet(this.setOnHandlerValve.bind(this, zone))
		this.accessoryValve[zone]
			.getCharacteristic(Characteristic.InUse)
			.onGet(this.getOnHandlerValve.bind(this, zone))
		this.accessoryValve[zone]
			.getCharacteristic(Characteristic.SetDuration)
			.setProps({ minValue: 0, maxValue: 7200 })
			.onSet(this.setOnHandlerZoneDuration.bind(this, zone))
		this.accessoryValve[zone]
			.getCharacteristic(Characteristic.RemainingDuration)
			.setProps({ minValue: 0, maxValue: 7200 })
			.onGet(this.getOnHandlerZoneDuration.bind(this, zone))
		
		this.service.addLinkedService(this.accessoryValve[zone])
		this.services.push(this.accessoryValve[zone])
		
		/*this.accessorySwitch[zone] = new Service.Switch("Zone " + String(zone) + " " + this.zones[zone - 1].zonename, zone)
		this.accessorySwitch[zone]
			.getCharacteristic(Characteristic.On)
			.onGet(this.getOnHandlerValve.bind(this, zone))
			.onSet(this.setOnHandlerSwitchValve.bind(this, zone))

		this.services.push(this.accessorySwitch[zone])*/
	}

	setInterval(() => {
		fetch("http://" + this.config.ip + ":8080/" + this.config.token + "/get/V" + this.config.pin)
			.then((response) => response.text())
			.then((data) =>  {
				data = data.slice(2, data.length - 2)
				let result = JSON.parse(data)
				for (let zone = 1; zone <= this.zoned; zone++) {
					if (this.accessoryValve[zone].getCharacteristic(Characteristic.InUse).value == 0 && result[zone].InUse == 1) {
						this.setInUseOn(zone)
					} else if (result[zone].InUse == 0) {
						this.setInUseOff(zone)
					}
				}
			})
				.catch((error) => {
					this.log.error(`Request to webhook failed. (${path})`);
					this.log.error(error);
			});
	}, 1000);
}

Irrigation.prototype.setOnHandlerZoneDuration = function (zone, value){
	this.zoneDuration[zone] = value
}

Irrigation.prototype.getOnHandlerZoneDuration = function (zone){
	let retTime = (this.zoneDuration[zone] - ((Date.now() - this.zoneTimeEnd[zone])/1000))
	if(retTime < 0){
		retTime = 0
	}
	return retTime
}

Irrigation.prototype.getOnHandlerValve = function (zone) {
	return this.accessoryValve[zone].getCharacteristic(Characteristic.InUse).value
}

Irrigation.prototype.setInUseOn = function (zone) {
	this.zoneTimeEnd[zone] = Date.now()
	this.accessoryValve[zone].updateCharacteristic(Characteristic.RemainingDuration, this.zoneDuration[zone])
	this.accessoryValve[zone].updateCharacteristic(Characteristic.InUse, Characteristic.InUse.IN_USE)
	this.accessoryValve[zone].updateCharacteristic(Characteristic.Active, Characteristic.Active.ACTIVE)
	this.timeOut[zone] = setTimeout(() => {
		this.setInUseOff(zone)
		this.sendValue()
	}, this.zoneDuration[zone] * 1000);	
}

Irrigation.prototype.setInUseOff = function (zone) {
	clearTimeout(this.timeOut[zone])
	this.accessoryValve[zone].updateCharacteristic(Characteristic.InUse, Characteristic.InUse.NOT_IN_USE)
	this.accessoryValve[zone].updateCharacteristic(Characteristic.Active, Characteristic.Active.INACTIVE)
	this.accessoryValve[zone].updateCharacteristic(Characteristic.RemainingDuration, 0)
}

Irrigation.prototype.setOnHandlerValve = function (zone, value) {
	if(value == true){
		this.setInUseOn(zone)
	} else {
		this.setInUseOff(zone)
	}
	this.sendValue()
}

Irrigation.prototype.sendValue = function (){
	let dataValue = `{"1":{"InUse":"${this.accessoryValve[1].getCharacteristic(Characteristic.InUse).value}"}`
	for (let zone = 2; zone <= this.zoned; zone++) {
		dataValue = dataValue + `,"${zone}":{"InUse":"${this.accessoryValve[zone].getCharacteristic(Characteristic.InUse).value}"}`
	}
	dataValue = dataValue + `}`
	fetch("http://" + this.config.ip + ":8080/" + this.config.token + "/update/V" + this.config.pin + "?value=" + dataValue)
		.then((response) => {  
			if (response.ok === false) {
				throw new Error(`Status code (${response.status})`);
			}
		})
			.catch((error) => {
				this.log.error(`Request to webhook failed. (${path})`);
				this.log.error(error);
		});
}

Irrigation.prototype.getServices = function () {
	return this.services;
};

