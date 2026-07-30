// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

abstract contract Ownable {
    address private _owner;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    constructor(address initialOwner) {
        require(initialOwner != address(0), "Ownable: zero address");
        _owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);
    }

    function owner() public view virtual returns (address) {
        return _owner;
    }

    modifier onlyOwner() {
        require(owner() == msg.sender, "Ownable: caller is not owner");
        _;
    }

    function transferOwnership(address newOwner) public virtual onlyOwner {
        require(newOwner != address(0), "Ownable: zero address");
        emit OwnershipTransferred(_owner, newOwner);
        _owner = newOwner;
    }
}

contract AEAEconomicAgentContract is Ownable {

    struct AgentConstitution {
        uint256 aiBudgetPerEpoch;
        uint256 econBudgetPerEpoch;
        bytes32 toolAllowlistRoot;
        uint16 maxCallDepth;
        bool active;
        bool emergencyStop;
    }

    mapping(uint256 => AgentConstitution) public constitutions;
    mapping(uint256 => uint256) public aiBudgetSpent;
    mapping(uint256 => uint256) public econBudgetSpent;

    event ConstitutionSet(uint256 indexed agentId, uint256 aiBudget, uint256 econBudget);
    event BatchSettled(uint256 indexed agentId, uint256 tokensConsumed, uint256 actionCount, bytes32 batchAuditRoot);

    constructor(address initialOwner) Ownable(initialOwner) {}

    function setConstitution(
        uint256 agentId,
        uint256 aiBudget,
        uint256 econBudget,
        bytes32 toolAllowlistRoot,
        uint16 maxDepth
    ) external onlyOwner {
        constitutions[agentId] = AgentConstitution({
            aiBudgetPerEpoch: aiBudget,
            econBudgetPerEpoch: econBudget,
            toolAllowlistRoot: toolAllowlistRoot,
            maxCallDepth: maxDepth,
            active: true,
            emergencyStop: false
        });

        emit ConstitutionSet(agentId, aiBudget, econBudget);
    }

    function authorizeAction(
        uint256 agentId,
        uint256 requestedTokens
    ) external view returns (bool isAllowed) {
        AgentConstitution memory config = constitutions[agentId];

        if (!config.active || config.emergencyStop) {
            return false;
        }

        if (aiBudgetSpent[agentId] + requestedTokens > config.aiBudgetPerEpoch) {
            return false;
        }

        return true;
    }

    function settleActionBatch(
        uint256 agentId,
        uint256 totalTokensConsumed,
        uint256 actionCount,
        bytes32 batchAuditRoot
    ) external onlyOwner {
        AgentConstitution storage config = constitutions[agentId];
        require(config.active, "Agent not active");
        require(!config.emergencyStop, "Emergency stop active");

        aiBudgetSpent[agentId] += totalTokensConsumed;

        emit BatchSettled(agentId, totalTokensConsumed, actionCount, batchAuditRoot);
    }
}